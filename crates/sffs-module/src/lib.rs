//! Feasibility probe for lane Y's builder bridge: how many host imports does a
//! module linking `runtime-core`'s image path actually need?
#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]
extern crate alloc;

#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
#[global_allocator]
static ALLOC: wasm::ModuleAllocator = wasm::ModuleAllocator(core::cell::UnsafeCell::new(
    dlmalloc::Dlmalloc::new(),
));

/// Mirrors `crates/wasm-artifact-module`: a RECLAIMING allocator growing from
/// the end of this module's own linear memory, so it adds no import.
#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
mod wasm {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;
    use dlmalloc::Dlmalloc;

    pub struct ModuleAllocator(pub UnsafeCell<Dlmalloc>);

    // SAFETY: one builder drives this module on one thread.
    unsafe impl Sync for ModuleAllocator {}

    unsafe impl GlobalAlloc for ModuleAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            unsafe { (*self.0.get()).malloc(layout.size(), layout.align()) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { (*self.0.get()).free(ptr, layout.size(), layout.align()) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            unsafe { (*self.0.get()).calloc(layout.size(), layout.align()) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            unsafe { (*self.0.get()).realloc(ptr, layout.size(), layout.align(), new_size) }
        }
    }
}


// # The module ABI
//
// Every entry point takes plain scalars: pointers and lengths into THIS
// module's own linear memory, which the caller fills through [`sm_alloc`].
// Operations return `0` on success and a negative errno on failure, so a
// caller never has to inspect a second channel to learn whether the first
// one worked.
//
// # Why this surface is fine-grained, and why that is not a V4 regression
//
// The builders make 175 direct filesystem calls across 25 distinct methods,
// spread through the recipes rather than funnelled through a helper
// vocabulary -- measured, after an earlier reading of lane Y's census
// concluded the opposite. Lane Y's premise is that the recipes are NOT
// touched, so the bridge meets them where they are.
//
// That is a wide EXPORT surface, and exports are not what goal V4 counts.
// V4 asks how many functions a new host must IMPLEMENT to run Kandelo. This
// module implements zero and imports zero: a new host inherits nothing from
// it, because the only consumer is the build-time TypeScript that drives
// image construction. A wide surface a host never sees costs the host floor
// nothing.

mod seal;

use runtime_core::rootfs;
use wasm_posix_shared::Errno;

/// Hand the caller a buffer in this module's memory to write into.
///
/// The builder owns the allocation until it passes the pointer to an entry
/// point or returns it with [`sm_free`]. Returning zero means the allocation
/// failed, which a caller must treat as fatal rather than writing to address
/// zero.
///
/// # Why `usize` and not `u32`
///
/// Pointers are `usize`, which is 32-bit on wasm32 -- so the EXPORTED
/// signature is exactly the i32 a wasm caller expects -- and 64-bit natively,
/// so the same source is testable off-target. Typing them `u32` because "wasm
/// pointers are 32-bit" compiles fine and then TRUNCATES every pointer in a
/// native test, which aborts in the allocator with no message. That cost a
/// debugging round here.
///
/// # Why a raw `Layout` and not a `Vec`
///
/// The first version built a `Vec`, `forget`-ed it, and rebuilt it in
/// `sm_free` with `from_raw_parts(ptr, len, len)`. That is undefined
/// behaviour: `try_reserve_exact` guarantees capacity of AT LEAST `len`, not
/// exactly `len`, so the reconstructed `Vec` can free a different size than
/// was allocated. It segfaulted on the second test that used it. Allocating
/// and freeing through the same explicit `Layout` removes the mismatch by
/// construction rather than relying on an allocator's discretion.
#[unsafe(no_mangle)]
pub extern "C" fn sm_alloc(len: usize) -> usize {
    // A zero-length request must still round-trip: the builders write empty
    // files, and "empty" must not be indistinguishable from "allocation
    // failed". One byte is cheaper than a second convention.
    //
    // NOT MUTATION-TESTABLE, and recorded rather than left as a permanent red.
    // Removing this `max` makes the call `alloc_zeroed(Layout(0, 1))`, which
    // Rust defines as UNDEFINED BEHAVIOUR rather than as returning null -- and
    // the platform allocator here hands back a unique non-null pointer for a
    // zero-size request anyway. So the mutant produces no observable wrong
    // value for a test to catch. A trial for it survives every time, and
    // "fixing" that by writing a test that happens to pass would be worse than
    // saying so here.
    let size = core::cmp::max(len, 1);
    let Ok(layout) = core::alloc::Layout::from_size_align(size, 1) else {
        return 0;
    };
    // SAFETY: size is non-zero, so this is a valid allocation request.
    let ptr = unsafe { alloc::alloc::alloc_zeroed(layout) };
    ptr as usize
}

/// Return a buffer obtained from [`sm_alloc`].
///
/// # Safety
/// `ptr` and `len` must be exactly what `sm_alloc` returned and was asked for.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_free(ptr: usize, len: usize) {
    if ptr == 0 {
        return;
    }
    let size = core::cmp::max(len, 1);
    let Ok(layout) = core::alloc::Layout::from_size_align(size, 1) else {
        return;
    };
    unsafe { alloc::alloc::dealloc(ptr as *mut u8, layout) };
}

/// The loaded image's bytes, ADOPTED from the host's allocation rather than
/// copied out of it.
///
/// # Why ownership transfers, when it transfers nowhere else
///
/// Every other entry point borrows the host's buffer for the duration of one
/// call and the host frees it afterwards. `sm_load_image` is the exception, and
/// the reason is size: `lamp.vfs` is 249 MiB. Copying would mean both the
/// host's buffer and the module's copy resident at once, in a 32-bit address
/// space, for the sole purpose of freeing one of them a moment later. The same
/// property that made the export stream rather than return a buffer applies to
/// the load.
///
/// So the contract is: on success the module owns `ptr` and the host must not
/// free it; the module frees it at the next `sm_load_image` or `sm_reset`. On
/// FAILURE ownership does not transfer and the host still owns its buffer —
/// because a caller that must inspect a return code to know whether it still
/// owns memory will eventually get it wrong, and the safe direction to be wrong
/// in is "the host frees what it allocated".
///
/// The bytes have to stay resident regardless of who owns them: a loaded image
/// hands out `BaseSource::Image` nodes, each a promise that the kernel can come
/// back for those bytes later. Freeing after the walk would make every base
/// file in a derived build unreadable.
struct AdoptedImage(core::cell::UnsafeCell<Option<(usize, usize)>>);

// SAFETY: one builder drives this module on one thread, as for the allocator.
unsafe impl Sync for AdoptedImage {}

static IMAGE: AdoptedImage = AdoptedImage(core::cell::UnsafeCell::new(None));

/// Free the adopted image, if there is one. Idempotent.
fn release_image() {
    // SAFETY: single-threaded module; no reference into the cell outlives this.
    let slot = unsafe { &mut *IMAGE.0.get() };
    if let Some((ptr, len)) = slot.take() {
        unsafe { sm_free(ptr, len) };
    }
}

/// The adopted image's bytes, or `None` when nothing is loaded.
fn image_bytes() -> Option<&'static [u8]> {
    // SAFETY: the buffer is freed only by `release_image`, which first clears
    // the slot, so a `Some` here describes live memory.
    let slot = unsafe { &*IMAGE.0.get() };
    slot.map(|(ptr, len)| unsafe { core::slice::from_raw_parts(ptr as *const u8, len) })
}

/// Serve the kernel's byte requests from the adopted image.
///
/// Only [`rootfs::ByteReq::Image`] can be answered: a blob store and an archive
/// transport are host capabilities this module does not have and will not grow.
/// `Base`/`Archive` therefore fail rather than returning zeros, so a builder
/// that reaches for content this module cannot supply hears about it.
fn image_source(req: rootfs::ByteReq, dst: &mut [u8]) -> Result<usize, Errno> {
    let rootfs::ByteReq::Image { offset } = req else {
        return Err(Errno::EIO);
    };
    let bytes = image_bytes().ok_or(Errno::EIO)?;
    let start = usize::try_from(offset).map_err(|_| Errno::EIO)?;
    if start >= bytes.len() {
        return Ok(0);
    }
    let n = core::cmp::min(dst.len(), bytes.len() - start);
    dst[..n].copy_from_slice(&bytes[start..start + n]);
    Ok(n)
}

/// Load a VFS image as the base layer: the kernel mounts it, walks it, and
/// adopts its deferred linkage, replacing whatever tree was there.
///
/// Returns the number of entries inserted, or a negative errno.
///
/// # Why one entry point and not three
///
/// A zero-import module cannot call back into the host for bytes, so the
/// obvious design is a push protocol — begin, write, finish — and that is three
/// exports. It is unnecessary: the host already has [`sm_alloc`], so it
/// allocates, copies the image in, and calls this once. The loader needs the
/// image randomly addressable — it walks directories and inodes in whatever
/// order the filesystem stores them — so streaming it in would not reduce peak
/// memory anyway.
///
/// # Safety
/// `ptr`/`len` must be exactly what [`sm_alloc`] returned and was asked for.
/// On success the module takes ownership; the host must not free it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_load_image(ptr: usize, len: usize) -> i32 {
    if ptr == 0 || len == 0 {
        return err(Errno::EINVAL);
    }
    // The PREVIOUS image goes first. `rootfs::load_image` resets the store, so
    // holding both would keep a buffer nothing can reach any more resident for
    // the length of the load -- the exact doubling this entry point exists to
    // avoid.
    release_image();
    // SAFETY: single-threaded module.
    unsafe { *IMAGE.0.get() = Some((ptr, len)) };

    match rootfs::load_image(len as u64, image_source) {
        Ok(entries) => {
            // AUTHENTICATE BEFORE THE IMAGE IS USABLE, not beside it.
            //
            // The incumbent exposes this as a separate `verify` the builder
            // must remember to await — a contract that exists only because
            // `SubtleCrypto` is a promise. A synchronous digest has no such
            // excuse, and a verification a caller can forget is one some caller
            // eventually will. Verifying here makes an UNVERIFIED loaded image
            // unrepresentable rather than merely discouraged.
            //
            // A refusal unloads: an image that failed to authenticate must not
            // be left mounted for the next call to build on.
            if let Err(e) = seal::verify_cohorts(&rootfs::archive_payloads()) {
                rootfs::reset();
                release_image();
                return err(e);
            }
            i32::try_from(entries).unwrap_or(i32::MAX)
        }
        Err(e) => {
            // Ownership did not transfer: clear the slot WITHOUT freeing, so
            // the host's buffer is still the host's to free.
            // SAFETY: single-threaded module.
            unsafe { *IMAGE.0.get() = None };
            err(e)
        }
    }
}

// ACCEPTED SURVIVING MUTANTS
//
// Mutation testing (`xtask perturb`) treats a surviving mutant as a failure,
// which is right: nearly always it means a missing test. Two mutants in this
// module survive for a reason no test can remove, and they are listed here so
// the next person neither ignores the gate nor writes a test that passes by
// accident:
//
//   1. `sm_alloc` dropping its `max(len, 1)`. The mutation makes the call
//      `alloc_zeroed(Layout(0, 1))`, which Rust defines as UNDEFINED
//      BEHAVIOUR rather than as returning null, and this platform's allocator
//      returns a unique non-null pointer for a zero-size request anyway. There
//      is no observable wrong value.
//   2. `sm_write_file` treating any `Ok` as success. The short-write branch is
//      unreachable because `rootfs::write` never returns a short count; the
//      check defends a contract, not an input.
//   3. `sm_write_file`'s byte source returning zeroes instead of EIO. That
//      source is never called: this entry point always truncates and writes
//      from offset 0, so prior contents are never needed, for a base file or
//      any other. Unreachable by construction -- see the entry point's own
//      docs, which say the same thing after an earlier version claimed the
//      opposite and a test disproved it.
//
// Every other mutant tried against this module has been killed.

/// Negative errno, the module's single failure convention.
fn err(e: Errno) -> i32 {
    -(e as i32)
}

fn ok_or_errno(result: Result<(), Errno>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(e) => err(e),
    }
}

/// # Safety
/// `ptr`/`len` must describe a readable range in this module's memory.
unsafe fn slice<'a>(ptr: usize, len: usize) -> &'a [u8] {
    if ptr == 0 || len == 0 {
        return &[];
    }
    unsafe { core::slice::from_raw_parts(ptr as *const u8, len) }
}

/// Discard the whole tree so the next image starts clean.
///
/// This is the release half of the release-before-create discipline lane Y
/// settled on: one live filesystem at a time, with an explicit teardown,
/// rather than an instance handle threaded through every operation. A test
/// pins that a build after this is indistinguishable from a first build.
#[unsafe(no_mangle)]
pub extern "C" fn sm_reset(root_mode: u32, uid: u32, gid: u32) -> i32 {
    rootfs::reset();
    // The image the old tree was built on goes with it. Without this a reset
    // would free every inode and keep 249 MiB of bytes nothing references.
    release_image();
    // Creating the root is part of the same transition, not a second one. No
    // caller ever reset without immediately initialising a root, and none
    // could usefully: a filesystem with no root fails every path operation, so
    // the state between the two calls was never a state anything wanted. Two
    // doors for one transition is the same redundancy that retired
    // `sm_stat_size`, and retiring this one paid for `sm_image_metadata`.
    ok_or_errno(rootfs::insert_base_dir(b"/", root_mode, uid, gid, 1))
}

/// # Safety
/// `path_ptr`/`path_len` must describe a readable range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_mkdir(path_ptr: usize, path_len: usize, mode: u32, uid: u32, gid: u32) -> i32 {
    ok_or_errno(rootfs::mkdir(unsafe { slice(path_ptr, path_len) }, mode, uid, gid))
}

/// Create every missing parent of `path`, like the builders' `ensureDirRecursive`.
///
/// Returns the number of directories created, which is deliberately not an
/// errno: `mkdir_parents` is infallible by design, leaving the caller's next
/// operation to report the real error against the real path rather than
/// guessing which errno the caller wanted.
///
/// # Safety
/// `path_ptr`/`path_len` must describe a readable range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_mkdir_parents(path_ptr: usize, path_len: usize, mode: u32, uid: u32, gid: u32) -> usize {
    rootfs::mkdir_parents(unsafe { slice(path_ptr, path_len) }, mode, uid, gid)
}

/// # Safety
/// Both ranges must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_symlink(
    target_ptr: usize,
    target_len: usize,
    link_ptr: usize,
    link_len: usize,
    uid: u32,
    gid: u32,
) -> i32 {
    ok_or_errno(rootfs::symlink(
        unsafe { slice(target_ptr, target_len) },
        unsafe { slice(link_ptr, link_len) },
        uid,
        gid,
    ))
}

/// # Safety
/// `path_ptr`/`path_len` must describe a readable range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_chmod(path_ptr: usize, path_len: usize, mode: u32) -> i32 {
    ok_or_errno(rootfs::chmod(unsafe { slice(path_ptr, path_len) }, mode))
}

/// `u32::MAX` leaves a field unchanged, matching the POSIX -1 convention the
/// TypeScript builders already pass.
///
/// # Safety
/// `path_ptr`/`path_len` must describe a readable range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_chown(path_ptr: usize, path_len: usize, uid: u32, gid: u32, clear_setid: u32) -> i32 {
    ok_or_errno(rootfs::chown(
        unsafe { slice(path_ptr, path_len) },
        uid,
        gid,
        clear_setid != 0,
    ))
}

/// Write a whole file, creating it and setting its mode -- the builders'
/// `writeVfsFile` / `writeVfsBinary` in one call.
///
/// Returns 0 on success, a negative errno on failure. A short write is
/// reported as EIO rather than as a byte count: a builder has no partial-write
/// recovery, and returning "wrote 40 of 900 bytes" to a caller with no way to
/// resume would turn a clear failure into a corrupt image.
///
/// **That branch is unreachable today, and kept deliberately.**
/// `rootfs::write` returns `Ok(buf.len())` or an error -- never a short count
/// -- so no input reaches it, and a mutant that treats any `Ok` as success
/// survives the suite. It stays because it defends a CONTRACT rather than an
/// input: `write` returns `usize`, and a future change that made it short-write
/// would otherwise turn a truncated file into a silent success. Recorded here
/// so the surviving mutant is a known, explained one rather than an
/// unexplained red that trains someone to ignore the gate.
///
/// # Why the byte source is unreachable here, which is not the same as loud
///
/// `write_file_at` takes a byte source so it can copy-on-write a BASE file --
/// one whose contents live in a loaded image rather than in the overlay. This
/// passes one that fails with EIO, and an earlier version of this comment
/// claimed that made the boundary "deliberately loud".
///
/// **That was wrong, and a test written to demonstrate it failed instead.**
/// This entry point always truncates and always writes from offset 0, so the
/// prior contents are never needed -- for a base file or any other. The source
/// is unreachable BY CONSTRUCTION, not a guard that fires.
///
/// The distinction matters for what comes next. A partial write (`offset > 0`,
/// or non-truncating) WOULD consult it, and a derived build that offers one
/// must wire it to real image bytes. A source that returned zeroes there would
/// produce an image that builds, boots, and is quietly wrong -- which is the
/// failure this lane's equivalence bar exists to catch. Keeping EIO means that
/// if this entry point ever grows a partial-write path, it fails rather than
/// fabricating.
///
/// # Safety
/// Both ranges must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_write_file(
    path_ptr: usize,
    path_len: usize,
    mode: u32,
    content_ptr: usize,
    content_len: usize,
) -> i32 {
    let path = unsafe { slice(path_ptr, path_len) };
    let content = unsafe { slice(content_ptr, content_len) };
    let result = rootfs::write_file_at(path, 0, content, mode, true, |_req, _dst| {
        Err(Errno::EIO)
    });
    match result {
        Ok(written) if written == content.len() => 0,
        Ok(_) => err(Errno::EIO),
        Err(e) => err(e),
    }
}

/// Field order of the [`sm_lstat`] record. Eight `u64`s, little-endian:
///
/// | offset | field |
/// |---|---|
/// | 0  | ino |
/// | 8  | mode |
/// | 16 | nlink |
/// | 24 | uid |
/// | 32 | gid |
/// | 40 | size |
/// | 48 | deferred (0 or 1) |
/// | 56 | archive_id (0 when not backed by an archive) |
///
/// # Why deferred-ness is a stat field and not an entry point of its own
///
/// Builder recipes ask two questions the TypeScript filesystem answered and
/// this module could not: `isPathDeferred(path)` and
/// `getLazyEntry(path) !== null`. They are real product assertions -- "dinit
/// must be resident before service boot", "the login program must be eager" --
/// and they were the only reason those recipes needed the IMPLEMENTATION
/// rather than an interface.
///
/// Adding `sm_lazy_info` would have answered them and made this the module's
/// twentieth entry point, one increment after `sffsModuleEntryPoints` was
/// banked at nineteen. Raising a ceiling you set yourself, immediately, is the
/// shape the budget exists to catch — and the better design was available:
/// whether a file's bytes are present is METADATA ABOUT THE FILE, which is
/// what `lstat` reports. `size` here is already the real length of a deferred
/// file rather than its zero-length stub, so the record was half-answering the
/// question already.
///
/// The record's length is discoverable by calling with `out_len == 0`, so growing it
/// costs the bridge nothing: it already asks rather than assuming.
///
/// # Why this is NOT the generated ABI stat layout
///
/// The obvious move is to serialize through `process_wire::write_stat`, which
/// writes the generated `process_layout::stat` record the syscall wire uses --
/// one authority, no second spelling. That is what this did first.
///
/// **It cannot work, because the generated layout is not exported to
/// TypeScript.** `host/src/generated/abi.ts` carries
/// `STRUCT_SIZE_WASM_STAT = 88` and no field offsets for it, so a TypeScript
/// bridge has nothing to decode with and would have to hand-copy the offsets
/// -- which is the hand-maintained-ABI-knowledge defect (L-D2, W-D1, V-D1)
/// this lane has been careful not to add a fourth instance of.
///
/// So the record here is deliberately a SMALL, MODULE-PRIVATE one. It is not
/// ABI: it crosses only between this module and its bridge, both built
/// together from one source tree, and the module's build key covers it. Six
/// fields in a fixed order is a contract two files can hold correctly; 88
/// bytes of kernel stat layout copied by hand is not.
///
/// If the generator later emits `process_layout::stat` offsets to TypeScript,
/// switching back is right and this comment is the reason to.
///
/// # Safety
/// Both ranges must describe readable/writable memory of the stated length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_lstat(
    path_ptr: usize,
    path_len: usize,
    out_ptr: usize,
    out_len: usize,
) -> i32 {
    const RECORD: usize = 8 * 8;
    // The size question is answered BEFORE the path is touched, so a caller
    // discovering the record's length needs no path to discover it with. This
    // is `sm_read_dir`'s and `sm_check_headroom`'s convention, and making
    // `sm_lstat` share it is what let a whole entry point reporting a constant
    // go: the ABI now carries ONE size-probe convention rather than two.
    if out_len == 0 {
        return RECORD as i32;
    }
    let path = unsafe { slice(path_ptr, path_len) };
    let stat = match rootfs::lstat(path) {
        Ok(stat) => stat,
        Err(e) => return err(e),
    };
    if out_ptr == 0 || out_len < RECORD {
        return err(Errno::EINVAL);
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    // `lazy_info` walks the same path a second time. Cheap, and it keeps
    // `lstat` reporting exactly what `rootfs::lstat` says rather than
    // assembling a stat from two sources that could disagree.
    let (deferred, _ino, _size, archive_id) = match rootfs::lazy_info(path) {
        Ok(info) => info,
        Err(e) => return err(e),
    };
    let fields: [u64; 8] = [
        stat.st_ino,
        stat.st_mode as u64,
        stat.st_nlink as u64,
        stat.st_uid as u64,
        stat.st_gid as u64,
        stat.st_size,
        u64::from(deferred),
        u64::from(archive_id),
    ];
    for (i, value) in fields.iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&value.to_le_bytes());
    }
    0
}

/// Read a symlink's target into `out`. Returns the byte count, or a negative
/// errno.
///
/// # Safety
/// Both ranges must describe readable/writable memory of the stated length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_readlink(
    path_ptr: usize,
    path_len: usize,
    out_ptr: usize,
    out_len: usize,
) -> i32 {
    let path = unsafe { slice(path_ptr, path_len) };
    if out_ptr == 0 {
        return err(Errno::EINVAL);
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    match rootfs::readlink(path, out) {
        Ok(n) => n as i32,
        Err(e) => err(e),
    }
}

/// Read file bytes at `offset` into `out`. Returns the byte count, or a
/// negative errno.
///
/// A caller reading a whole file sizes `out` from [`sm_lstat`]'s `st_size`
/// rather than guessing, and a short return means end of file rather than an
/// error -- the same contract POSIX `read` has, so a builder's loop is the one
/// it already knows how to write.
///
/// # Safety
/// Both ranges must describe readable/writable memory of the stated length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_read_file(
    path_ptr: usize,
    path_len: usize,
    offset: i64,
    out_ptr: usize,
    out_len: usize,
) -> i32 {
    let path = unsafe { slice(path_ptr, path_len) };
    if out_ptr == 0 {
        return err(Errno::EINVAL);
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    // A file that came from a LOADED image reads out of that image, which this
    // module still holds. Blob- and archive-backed content stays unreachable:
    // those are host transports this module does not have, and `image_source`
    // fails loudly rather than returning zeros for them.
    match rootfs::read_file_at(path, offset, out, image_source) {
        Ok(n) => n as i32,
        Err(e) => err(e),
    }
}

/// List a directory's entries as a length-prefixed pack: for each entry, a
/// little-endian `u32` name length followed by that many name bytes.
///
/// Returns the number of bytes written, or a negative errno. **Call it with
/// `out_len == 0` to learn the size required**, then allocate and call again;
/// the required size is returned as a positive count with nothing written.
///
/// # Why a snapshot, and not an opendir/readdir/closedir handle
///
/// The builders loop with `opendir`/`readdir`/`closedir`, and the bridge will
/// still present exactly that -- but in TypeScript, over one snapshot. Keeping
/// the handle on the TypeScript side means no directory-iterator lifetime
/// crosses the module boundary, so a builder that throws mid-loop cannot leak
/// one, and the module needs three fewer entry points.
///
/// The cost is holding a directory's names at once. Image directories are
/// bounded in the thousands, and the alternative -- a handle whose lifetime
/// spans arbitrary caller code -- trades a bounded allocation for an unbounded
/// class of leak. Worth stating rather than leaving as an implicit limit.
///
/// Names are length-prefixed rather than delimited because a POSIX name may
/// contain any byte except `/` and NUL, so no separator is safe.
///
/// # Safety
/// Both ranges must describe readable/writable memory of the stated length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_read_dir(
    path_ptr: usize,
    path_len: usize,
    out_ptr: usize,
    out_len: usize,
) -> i32 {
    let path = unsafe { slice(path_ptr, path_len) };
    let handle = match rootfs::opendir(path) {
        Ok(handle) => handle,
        Err(e) => return err(e),
    };

    let mut names: alloc::vec::Vec<alloc::vec::Vec<u8>> = alloc::vec::Vec::new();
    let mut name_buf = alloc::vec![0u8; 256];
    loop {
        match rootfs::readdir(handle, &mut name_buf) {
            Ok(Some((_ino, _kind, len))) => names.push(name_buf[..len].to_vec()),
            Ok(None) => break,
            Err(e) => {
                rootfs::closedir(handle).ok();
                return err(e);
            }
        }
    }
    rootfs::closedir(handle).ok();

    let required: usize = names.iter().map(|n| 4 + n.len()).sum();
    if out_len == 0 {
        // Size query. A caller allocating from this must not assume the tree
        // is unchanged between calls; nothing mutates it mid-build, which is
        // why the two-call shape is safe HERE and would not be in general.
        return required as i32;
    }
    if out_len < required {
        return err(Errno::ERANGE);
    }
    if out_ptr == 0 {
        return err(Errno::EINVAL);
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    let mut at = 0usize;
    for name in &names {
        out[at..at + 4].copy_from_slice(&(name.len() as u32).to_le_bytes());
        at += 4;
        out[at..at + name.len()].copy_from_slice(name);
        at += name.len();
    }
    at as i32
}

/// Stream the built image's bytes at `offset` into `out`. Returns the byte
/// count, 0 at end of image, or a negative errno.
///
/// Calling at offset 0 BUILDS the image from the current tree; later offsets
/// stream from that build. So a caller reads from 0 upward and must not
/// interleave mutations, or it will stream a plan describing a tree that has
/// since changed.
///
/// # Why streaming rather than "give me the image"
///
/// `lamp.vfs` is 249 MiB. The writer never materializes file content -- a data
/// block carrying file bytes is a reference resolved as it is read -- so an
/// entry point returning one buffer would undo the property that lets a 249
/// MiB image be emitted without holding 249 MiB. This is lane V's V3 shape,
/// reused rather than re-solved.
///
/// # Safety
/// `out_ptr`/`out_len` must describe writable memory of the stated length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_export_image_read(offset: i64, out_ptr: usize, out_len: usize) -> i32 {
    if out_ptr == 0 {
        return err(Errno::EINVAL);
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    // A DERIVED build's base content comes from the image it was loaded from,
    // which this module still holds -- so `BaseSource::Image` nodes resolve and
    // a derived export carries its base files' real bytes. A fresh build has no
    // base files and never consults this. Blob- and archive-backed content
    // remain unreachable: those are host transports this module does not have.
    // SEAL HERE, at the export door, because this is the only way bytes leave
    // the module. A builder cannot compute a cohort digest as it registers --
    // that digest covers every member and the last one is not known until the
    // archive set is complete -- so sealing has to happen after registration
    // and before emission. A `finalise` call would fit there too, and could be
    // forgotten; this cannot.
    //
    // Only at offset 0, which is where the export plan is built. A later chunk
    // is reading a plan whose payloads are already sealed.
    if offset == 0 {
        let declared = rootfs::archive_payloads();
        match seal::seal_cohorts(&declared) {
            Ok(sealed) => {
                for (archive_id, payload) in sealed {
                    if let Err(e) = rootfs::set_archive_payload(archive_id, &payload) {
                        return err(e);
                    }
                }
            }
            Err(e) => return err(e),
        }
    }
    let mut source = image_source;
    // The whole VFSI CONTAINER, not the bare SFFS body. A body is not an image:
    // nothing can find the filesystem inside it or the sections beside it. The
    // builder saving these bytes should be saving something the kernel can load
    // back, and assembling the container host-side would make the host a second
    // author of the format this lane exists to give one.
    match rootfs::export_container_read(offset, out, &mut source) {
        Ok(n) => n as i32,
        Err(e) => err(e),
    }
}

/// Read back the image metadata this filesystem currently carries.
///
/// Returns the byte count written, or the record's length when `out_len` is 0 —
/// the module's one size-probe convention, shared with `sm_read_dir`,
/// `sm_check_headroom` and `sm_lstat`. A filesystem carrying no metadata
/// answers 0, which is "there is none" and not an error.
///
/// # Why the kernel hands back BYTES and parses nothing
///
/// The metadata is an open JSON shape — `version`, `kernelAbi`, `createdBy`,
/// and whatever a future producer adds. A Rust reader that parsed it into a
/// struct and re-serialised would silently drop every field it did not know
/// about, which is the opposite of what an open shape is for, and teaching the
/// kernel crate to parse JSON for three fields it does not act on would buy a
/// parser's attack surface for nothing. So the kernel carries these bytes
/// exactly as it carries a deferred file's payload: opaquely.
///
/// # Why this needs an entry point at all
///
/// After a load the KERNEL holds the metadata — the image declared it and
/// `load_image` keeps it. The bridge cannot answer from anything it kept,
/// because it never sent it. Every builder that reads this is CHECKING it: six
/// call sites, all comparing `kernelAbi` against what the build expects, which
/// is a guard that must read the base's real answer rather than the builder's
/// own memory of what it set.
///
/// # Safety
/// `out_ptr`/`out_len` must describe a writable range when `out_len` is nonzero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_image_metadata(out_ptr: usize, out_len: usize) -> i32 {
    let metadata = rootfs::image_metadata();
    let len = metadata.as_ref().map_or(0, |bytes| bytes.len());
    if out_len == 0 {
        return i32::try_from(len).unwrap_or(i32::MAX);
    }
    if out_ptr == 0 || out_len < len {
        return err(Errno::EINVAL);
    }
    if let Some(bytes) = metadata {
        let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
        out[..bytes.len()].copy_from_slice(&bytes);
    }
    i32::try_from(len).unwrap_or(i32::MAX)
}

/// Set what the exported image should be: its declared capacity, and the
/// metadata section it carries.
///
/// `capacity_bytes` is a FLOOR on the growth ceiling, not a size — the export
/// still sizes itself to hold the tree, and 0 means "no request". A product
/// declares this and its publication gate checks the artifact against it;
/// without it the export sizes to its own tree and meets no declared capacity.
///
/// Opaque bytes: the builder's statements about its own artifact (`version`,
/// `kernelAbi`, `createdBy`). The kernel stores and emits them without reading
/// them. Passing an empty range clears it.
///
/// # Safety
/// `ptr`/`len` must describe a readable range, or `len` must be 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_set_image_options(
    capacity_bytes: u64,
    ptr: usize,
    len: usize,
) -> i32 {
    // Capacity and metadata travel together because they are the same KIND of
    // thing: statements a builder makes about the artifact it wants, as opposed
    // to operations on the tree inside it. One export for "settings for the
    // image you will produce" rather than one per setting — the same reasoning
    // that folded capacity into the headroom record instead of adding a second
    // query.
    if let Err(e) = rootfs::set_image_capacity(capacity_bytes) {
        return err(e);
    }
    let bytes: &[u8] = if len == 0 {
        b""
    } else {
        if ptr == 0 {
            return err(Errno::EINVAL);
        }
        unsafe { slice(ptr, len) }
    };
    ok_or_errno(rootfs::set_image_metadata(bytes))
}

/// Register a file whose bytes live in a lazy archive rather than the image.
///
/// This is the builders' `registerLazyFile`. It is not an edge case: the
/// shipped shell image carries 7,546 deferred entries against 79 URL-backed
/// single files, so the overwhelming majority of a production image's files
/// arrive this way. A bridge without it could build only trivial images.
///
/// `size` is the file's REAL length, authoritative from the manifest. The body
/// inode is a zero-length stub and the size rides in the deferred record --
/// the SDEF contract -- so a reader knows how much to fetch without having
/// fetched anything.
///
/// # Safety
/// Both ranges must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_register_lazy_file(
    path_ptr: usize,
    path_len: usize,
    archive_id: u32,
    source_ptr: usize,
    source_len: usize,
    size: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    ino: u64,
    archive_bytes: u64,
    archive_payload_ptr: usize,
    archive_payload_len: usize,
    cohort_id_ptr: usize,
    cohort_id_len: usize,
    cohort_member_ptr: usize,
    cohort_member_len: usize,
    cohort_expected_count: u32,
) -> i32 {
    // The archive's length is declared HERE rather than through an entry point
    // of its own. A member is useless without it -- fetching one member means
    // fetching the archive, and that read has to be bounded -- so taking it
    // alongside the member makes it impossible to register a member whose
    // archive has no length, without costing the host another export to
    // implement. Re-declaring the same length is a no-op; a different one is
    // EINVAL, because one archive with two lengths has no correct reading.
    //
    // `archive_payload` is the archive's own fetch description -- URL,
    // transport, integrity digest -- carried opaquely like a file's. It rides
    // here for the same reason the length does. Empty is allowed: whether a
    // producer MUST supply a digest is lane S's question, and answering it in
    // this ABI would decide it by accident.
    let archive_payload: &[u8] = if archive_payload_len == 0 {
        b""
    } else {
        if archive_payload_ptr == 0 {
            return err(Errno::EINVAL);
        }
        unsafe { slice(archive_payload_ptr, archive_payload_len) }
    };
    // `archive_id == 0` is a file fetched STANDALONE — no archive behind it, so
    // nothing to declare, and the payload belongs to the FILE rather than to an
    // archive. That case was unreachable through this entry point until now,
    // because the archive declaration below refuses id 0: the bridge could
    // register an archive member and could not register the shape 79 files in
    // the shipped shell image actually have, which is also the shape lane S's
    // setuid defect is about.
    if archive_id != 0 {
        // The length is the STORE's rule: one archive with two lengths has no
        // correct reading, and it can say so without reading anything.
        if let Err(e) = rootfs::declare_archive(archive_id, archive_bytes) {
            return err(e);
        }
        // The description is the FORMAT's, so it is merged here. Registration
        // is per file and a description is per archive, so a builder carries
        // it on one member and omits it on the rest; deciding that an omitted
        // description says nothing, and that two given ones must agree, means
        // reading the payload, which only the module can do.
        //
        // Gap 18 is why the module writes the envelope at all: storing the
        // caller's bytes made a plain JSON descriptor decode as a versioned
        // record, and its first four bytes became a version word. Gap 19 is
        // why the merge came here too — wrapping an OMITTED description
        // produced a nine-byte envelope describing nothing, which the store
        // saw as a second, different description of one archive and refused.
        let cohort_id = unsafe { slice(cohort_id_ptr, cohort_id_len) };
        let cohort_member = unsafe { slice(cohort_member_ptr, cohort_member_len) };
        let existing = rootfs::archive_payload(archive_id).unwrap_or_default();
        let mut payload = match seal::decode(&existing) {
            Ok(payload) => payload,
            Err(e) => return err(e),
        };
        if !archive_payload.is_empty() {
            if !payload.descriptor.is_empty() && payload.descriptor != archive_payload {
                return err(Errno::EINVAL);
            }
            payload.descriptor = archive_payload.to_vec();
        }
        // The cohort declaration rides here for the same reason the length and
        // the description do: a cohort MEMBER is an archive, and this is where
        // an archive is named. It could have been an `sm_declare_cohort` of its
        // own, which would have bought a tidier signature with a permanent
        // entry in the builders' ABI -- and the budget record already argues
        // this case for this call, for the archive length.
        //
        // An empty id means "not in a cohort", which is what nearly every
        // archive is.
        if !cohort_id.is_empty() {
            let declared = (cohort_id, cohort_member, cohort_expected_count);
            match payload.seal.cohort() {
                // Members of one cohort must agree about the cohort. This is
                // the same rule as the description's, and it compares
                // membership rather than the whole seal so that declaring a
                // member again after an export -- which turned the declaration
                // into a SEAL -- is a no-op rather than a conflict.
                Some(existing) if existing != declared => return err(Errno::EINVAL),
                Some(_) => {}
                None => {
                    payload.seal = seal::SealState::Pending {
                        id: cohort_id.to_vec(),
                        member: cohort_member.to_vec(),
                        expected_count: cohort_expected_count,
                    }
                }
            }
        }
        // An archive with nothing to say keeps an EMPTY payload rather than an
        // envelope describing nothing. Empty already means "no description" at
        // every other layer -- it is what a `KLZY`-described image carries and
        // what `decode` accepts early -- and encoding that same absence as
        // nine bytes would put a deferred section into images that have no
        // deferred anything to describe.
        let wrapped = if payload.descriptor.is_empty() && payload.seal == seal::SealState::None {
            alloc::vec::Vec::new()
        } else {
            match seal::encode(&payload) {
                Ok(bytes) => bytes,
                Err(e) => return err(e),
            }
        };
        if let Err(e) = rootfs::set_archive_payload(archive_id, &wrapped) {
            return err(e);
        }
    }
    ok_or_errno(rootfs::insert_lazy_file(
        unsafe { slice(path_ptr, path_len) },
        archive_id,
        unsafe { slice(source_ptr, source_len) },
        size,
        mode,
        uid,
        gid,
        ino,
        // With an archive, the payload described the ARCHIVE and the file needs
        // none of its own. Without one, it describes the file.
        if archive_id == 0 { archive_payload } else { b"" },
    ))
}

/// Measure the image this tree would export, and judge its headroom.
///
/// Writes five little-endian `u64`s — `free_bytes`, `required_bytes`,
/// `free_inodes`, `required_inodes`, `capacity_bytes` — and returns 0 when the
/// headroom profile is met, or `-EDOM` when it is not, with the numbers in
/// `out` either way.
///
/// **One call rather than one per assertion.** Capacity was briefly a second
/// entry point and the surface budget refused it, correctly: the builders make
/// several assertions about one artifact, and each is a separate ABI crossing
/// only if the module is asked one question at a time. What crosses is the set
/// of FACTS about the image, plus the verdict that needs kernel arithmetic.
///
/// Capacity is reported and not judged here, deliberately. Parsing the ceiling
/// out of a container header and an SFFS superblock is format knowledge and
/// belongs on this side; comparing the result to a number the profile declares
/// is a comparison, and belongs with whoever holds the profile. Call with
/// `out_len == 0` for the required size, the convention `sm_read_dir` uses.
///
/// # Why a POLICY and not a `statfs`
///
/// The builders' `assertVfsImageHeadroom` reads `statfs`, multiplies free
/// blocks by block size, compares two numbers and formats a message. Exposing
/// `statfs` would have been one line and would have left that arithmetic and
/// that judgement in TypeScript — moving a syscall rather than a decision, and
/// leaving the host doing MORE work while the surface count looked better.
///
/// `image_policy::check_headroom` already performs exactly this computation
/// over `Sffs::statfs`, so what crosses the boundary is the verdict plus the
/// numbers behind it. The caller still formats the message, because a `no_std`
/// policy that owned its own prose would force one wording on every host.
///
/// # Why it costs an entry point, deliberately
///
/// This is the module's twentieth, against a `sffsModuleEntryPoints` budget
/// banked at nineteen. The budget's own rule is that the surface does not grow
/// WITHOUT AN ARGUMENT, and the argument is that the host ends up doing less:
/// a primitive and a computation in TypeScript become one verdict. It is also
/// the last method standing between `vfs-image-helpers.ts` — the funnel every
/// builder reaches the format through — and an interface it can be typed
/// against.
///
/// # Safety
/// `out_ptr`/`out_len` must describe a writable range when `out_len` is nonzero.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_check_headroom(
    minimum_free_bytes: u64,
    minimum_free_inodes: u64,
    out_ptr: usize,
    out_len: usize,
) -> i32 {
    const RECORD: usize = 5 * 8;
    if out_len == 0 {
        return RECORD as i32;
    }
    if out_ptr == 0 || out_len < RECORD {
        return err(Errno::EINVAL);
    }

    let headroom = runtime_core::image_policy::Headroom {
        minimum_free_bytes,
        minimum_free_inodes,
    };
    let outcome = match rootfs::check_export_headroom(&headroom) {
        Ok(outcome) => outcome,
        Err(e) => return err(e),
    };
    let capacity = match rootfs::export_capacity_bytes() {
        Ok(bytes) => bytes,
        Err(e) => return err(e),
    };
    let fields = [
        outcome.free_bytes,
        outcome.required_bytes,
        outcome.free_inodes,
        outcome.required_inodes,
        capacity,
    ];
    let rc = if outcome.met { 0 } else { err(Errno::EDOM) };

    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    for (index, value) in fields.iter().enumerate() {
        out[index * 8..index * 8 + 8].copy_from_slice(&value.to_le_bytes());
    }
    rc
}

/// # Safety
/// `path_ptr`/`path_len` must describe a readable range.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sm_unlink(path_ptr: usize, path_len: usize) -> i32 {
    ok_or_errno(rootfs::unlink(unsafe { slice(path_ptr, path_len) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the module the way the bridge will: allocate a buffer, write a
    /// path into it, call through the ABI, and read the result back through
    /// the same filesystem the kernel uses.
    ///
    /// These run natively, not in wasm, so they exercise the ABI's shape --
    /// pointer/length marshalling and the errno convention -- rather than its
    /// wasm calling convention. That split is deliberate: a wasm harness would
    /// test the linker, and the linker is already gated by the build script's
    /// zero-import check.
    fn write_path(path: &[u8]) -> (usize, usize) {
        let ptr = sm_alloc(path.len());
        assert_ne!(ptr, 0, "allocation must succeed");
        unsafe {
            core::ptr::copy_nonoverlapping(path.as_ptr(), ptr as *mut u8, path.len());
        }
        (ptr, path.len())
    }

    fn with_path<R>(path: &[u8], f: impl FnOnce(usize, usize) -> R) -> R {
        let (ptr, len) = write_path(path);
        let result = f(ptr, len);
        unsafe { sm_free(ptr, len) };
        result
    }

    #[test]
    fn the_write_path_builds_a_tree_through_the_abi() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/usr", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        assert_eq!(
            with_path(b"/usr/lib/kandelo", |p, l| unsafe { sm_mkdir_parents(p, l, 0o755, 0, 0) }),
            1,
            "one missing parent (/usr/lib) created; /usr already existed",
        );
        assert_eq!(
            with_path(b"/usr/bin", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }),
            0
        );
        let rc = with_path(b"/usr/bin/sh", |lp, ll| {
            with_path(b"../lib/sh", |tp, tl| unsafe { sm_symlink(tp, tl, lp, ll, 7, 8) })
        });
        assert_eq!(rc, 0);

        let st = rootfs::lstat(b"/usr/bin/sh").expect("symlink exists");
        assert_eq!(st.st_mode & 0o7777, 0o777);
        assert_eq!((st.st_uid, st.st_gid), (7, 8));
    }

    #[test]
    fn metadata_operations_reach_the_filesystem() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/opt", |p, l| unsafe { sm_mkdir(p, l, 0o700, 1, 2) }), 0);
        assert_eq!(with_path(b"/opt", |p, l| unsafe { sm_chmod(p, l, 0o751) }), 0);
        assert_eq!(
            with_path(b"/opt", |p, l| unsafe { sm_chown(p, l, 5, u32::MAX, 0) }),
            0
        );
        let st = rootfs::lstat(b"/opt").expect("dir exists");
        assert_eq!(st.st_mode & 0o7777, 0o751);
        assert_eq!(
            (st.st_uid, st.st_gid),
            (5, 2),
            "u32::MAX must leave the gid unchanged, as POSIX -1 does",
        );
    }

    /// A failure arrives as a negative errno through the same return value as
    /// success, so a caller never consults a second channel to find out.
    fn with_two<R>(a: &[u8], b: &[u8], f: impl FnOnce(usize, usize, usize, usize) -> R) -> R {
        let (ap, al) = write_path(a);
        let (bp, bl) = write_path(b);
        let r = f(ap, al, bp, bl);
        unsafe { sm_free(ap, al) };
        unsafe { sm_free(bp, bl) };
        r
    }

    #[test]
    fn files_are_written_with_their_contents_and_mode() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/etc", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);

        let body = b"root:x:0:0:root:/root:/bin/sh\n";
        let rc = with_two(b"/etc/passwd", body, |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        });
        assert_eq!(rc, 0);

        let st = rootfs::lstat(b"/etc/passwd").expect("passwd exists");
        assert_eq!(st.st_mode & 0o7777, 0o644);
        assert_eq!(st.st_size as usize, body.len());

        let mut back = alloc::vec![0u8; body.len()];
        let n = rootfs::read_file_at(b"/etc/passwd", 0, &mut back, |_r, _d| Err(Errno::EIO))
            .expect("read back");
        assert_eq!(&back[..n], body, "the bytes written must be the bytes stored");
    }

    /// A truncating whole-file write over a BASE file succeeds, and does not
    /// consult the base bytes.
    ///
    /// This test was written to prove the opposite -- that the boundary failed
    /// loudly -- and failed, which is how the module's documentation got
    /// corrected. A full replace never needs the prior contents, so a base
    /// file is overwritten exactly like an overlay one. The byte source that
    /// returns EIO is never called, and the write succeeds.
    #[test]
    fn a_full_rewrite_of_a_base_file_needs_no_base_bytes() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        // A base file: metadata in the overlay, contents nominally in a host
        // blob this module cannot read.
        rootfs::insert_base_file(b"/base.bin", 42, 16, 0o644, 0, 0, 7).expect("insert base");

        let rc = with_two(b"/base.bin", b"overwrite", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o600, cp, cl)
        });
        assert_eq!(
            rc, 0,
            "a full replace needs no prior contents, so an unreadable base must not block it",
        );

        let st = rootfs::lstat(b"/base.bin").expect("still exists");
        assert_eq!(st.st_size, 9, "the base file's declared size is replaced by the new bytes");
        assert_eq!(st.st_mode & 0o7777, 0o600);

        let mut back = alloc::vec![0u8; 9];
        let n = rootfs::read_file_at(b"/base.bin", 0, &mut back, |_r, _d| Err(Errno::EIO))
            .expect("read back");
        assert_eq!(&back[..n], b"overwrite", "and the content is the overlay's, not the base's");
    }

    /// An empty file is a file, not a failure. The builders write them.
    #[test]
    fn an_empty_file_round_trips() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let rc = with_two(b"/empty", b"", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o600, cp, cl)
        });
        assert_eq!(rc, 0);
        let st = rootfs::lstat(b"/empty").expect("empty exists");
        assert_eq!(st.st_size, 0);
        assert_eq!(st.st_mode & 0o7777, 0o600);
    }

    /// A truncating rewrite replaces both the bytes AND the mode, matching
    /// write_file_at's contract that create and replace behave alike.
    #[test]
    fn rewriting_a_file_replaces_its_bytes_and_mode() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(
            with_two(b"/f", b"a much longer original", |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o755, cp, cl)
            }),
            0
        );
        assert_eq!(
            with_two(b"/f", b"short", |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o600, cp, cl)
            }),
            0
        );
        let st = rootfs::lstat(b"/f").expect("f exists");
        assert_eq!(st.st_size, 5, "the longer original must be truncated away");
        assert_eq!(st.st_mode & 0o7777, 0o600, "a replace sets the mode too");
    }

    /// The six-field record decodes at the documented offsets.
    #[test]
    fn lstat_writes_the_documented_record() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(
            with_two(b"/f", b"12345", |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o640, cp, cl)
            }),
            0
        );
        assert_eq!(with_path(b"/f", |p, l| unsafe { sm_chown(p, l, 3, 4, 0) }), 0);

        let size = unsafe { sm_lstat(0, 0, 0, 0) } as usize;
        assert_eq!(size, 64, "eight u64 fields");
        let out = sm_alloc(size);
        assert_ne!(out, 0);
        let rc = with_path(b"/f", |p, l| unsafe { sm_lstat(p, l, out, size) });
        assert_eq!(rc, 0);

        let bytes = unsafe { core::slice::from_raw_parts(out as *const u8, size) };
        let at = |i: usize| {
            let mut v = [0u8; 8];
            v.copy_from_slice(&bytes[i * 8..i * 8 + 8]);
            u64::from_le_bytes(v)
        };
        assert_eq!(at(1) & 0o7777, 0o640, "mode at field 1");
        assert_eq!(at(3), 3, "uid at field 3");
        assert_eq!(at(4), 4, "gid at field 4");
        assert_eq!(at(5), 5, "size at field 5");
        assert_eq!(at(6), 0, "not deferred, at field 6");
        assert_eq!(at(7), 0, "no archive, at field 7");
        unsafe { sm_free(out, size) };
    }

    /// A buffer too small for the record is refused rather than partially
    /// filled: a half-written stat is worse than no stat, because it looks
    /// like data.
    #[test]
    fn lstat_refuses_an_undersized_buffer() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let size = unsafe { sm_lstat(0, 0, 0, 0) } as usize;
        let out = sm_alloc(size);
        let rc = with_path(b"/", |p, l| unsafe { sm_lstat(p, l, out, size - 1) });
        assert!(rc < 0, "an undersized buffer must fail, got {rc}");
        unsafe { sm_free(out, size) };
    }

    #[test]
    fn readlink_and_read_file_return_byte_counts() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(
            with_two(b"/data", b"hello world", |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o644, cp, cl)
            }),
            0
        );
        let rc = with_two(b"/link", b"data", |lp, ll, tp, tl| unsafe {
            sm_symlink(tp, tl, lp, ll, 0, 0)
        });
        assert_eq!(rc, 0);

        let buf = sm_alloc(32);
        let n = with_path(b"/link", |p, l| unsafe { sm_readlink(p, l, buf, 32) });
        assert_eq!(n, 4);
        let target = unsafe { core::slice::from_raw_parts(buf as *const u8, 4) };
        assert_eq!(target, b"data");

        let n = with_path(b"/data", |p, l| unsafe { sm_read_file(p, l, 0, buf, 32) });
        assert_eq!(n, 11);
        let body = unsafe { core::slice::from_raw_parts(buf as *const u8, 11) };
        assert_eq!(body, b"hello world");

        // Reading past the end returns 0, not an error -- POSIX read's
        // contract, so a builder's loop terminates the way it expects.
        let n = with_path(b"/data", |p, l| unsafe { sm_read_file(p, l, 11, buf, 32) });
        assert_eq!(n, 0);
        unsafe { sm_free(buf, 40) };
    }

    /// Reading a BASE file is the case the write path could not reach: its
    /// bytes live in a host blob this module has no access to, so the failure
    /// is real rather than unreachable, and must be loud.
    #[test]
    fn reading_a_base_file_fails_loudly_rather_than_returning_zeroes() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        rootfs::insert_base_file(b"/base.bin", 42, 16, 0o644, 0, 0, 7).expect("insert base");
        let buf = sm_alloc(16);
        let rc = with_path(b"/base.bin", |p, l| unsafe { sm_read_file(p, l, 0, buf, 16) });
        assert!(
            rc < 0,
            "a base file's bytes are unreachable here; returning zeroes would be a silent lie, got {rc}",
        );
        unsafe { sm_free(buf, 16) };
    }

    /// Decode the length-prefixed pack the way the bridge will.
    fn unpack(ptr: usize, len: usize) -> alloc::vec::Vec<alloc::vec::Vec<u8>> {
        let bytes = unsafe { core::slice::from_raw_parts(ptr as *const u8, len) };
        let mut out = alloc::vec::Vec::new();
        let mut at = 0usize;
        while at + 4 <= bytes.len() {
            let n = u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
                as usize;
            at += 4;
            out.push(bytes[at..at + n].to_vec());
            at += n;
        }
        out
    }

    #[test]
    fn read_dir_lists_entries_and_sizes_itself() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/d", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        for name in [&b"/d/one"[..], &b"/d/two"[..], &b"/d/three"[..]] {
            assert_eq!(
                with_two(name, b"x", |pp, pl, cp, cl| unsafe { sm_write_file(pp, pl, 0o644, cp, cl) }),
                0
            );
        }

        // Size query first, exactly as the bridge will.
        let required = with_path(b"/d", |p, l| unsafe { sm_read_dir(p, l, 0, 0) });
        assert!(required > 0, "a size query must report the bytes needed, got {required}");
        let expected: i32 = (4 + 3) + (4 + 3) + (4 + 5); // one, two, three
        assert_eq!(required, expected, "4-byte prefix plus each name");

        let buf = sm_alloc(required as usize);
        let n = with_path(b"/d", |p, l| unsafe { sm_read_dir(p, l, buf, required as usize) });
        assert_eq!(n, required);

        let mut names = unpack(buf, n as usize);
        names.sort();
        assert_eq!(names, alloc::vec![b"one".to_vec(), b"three".to_vec(), b"two".to_vec()]);
        unsafe { sm_free(buf, required as usize) };
    }

    /// A buffer smaller than the pack is refused, not truncated. A truncated
    /// pack decodes as a SHORTER DIRECTORY rather than as an error, so the
    /// caller would silently miss files -- in an image builder, that is a
    /// missing binary nobody notices until something runs.
    #[test]
    fn read_dir_refuses_a_buffer_that_would_truncate() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/d", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        assert_eq!(
            with_two(b"/d/file", b"x", |pp, pl, cp, cl| unsafe { sm_write_file(pp, pl, 0o644, cp, cl) }),
            0
        );
        let required = with_path(b"/d", |p, l| unsafe { sm_read_dir(p, l, 0, 0) });
        let buf = sm_alloc(required as usize);
        let rc = with_path(b"/d", |p, l| unsafe {
            sm_read_dir(p, l, buf, (required - 1) as usize)
        });
        assert!(rc < 0, "an undersized buffer must fail rather than truncate, got {rc}");
        unsafe { sm_free(buf, required as usize) };
    }

    #[test]
    fn read_dir_on_an_empty_directory_is_empty_not_an_error() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/empty", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        let required = with_path(b"/empty", |p, l| unsafe { sm_read_dir(p, l, 0, 0) });
        assert_eq!(required, 0, "an empty directory needs no bytes, and is not a failure");
    }

    #[test]
    fn read_dir_on_a_missing_path_is_an_error() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let rc = with_path(b"/nope", |p, l| unsafe { sm_read_dir(p, l, 0, 0) });
        assert!(rc < 0, "a missing directory must be an error, not an empty listing, got {rc}");
    }

    /// What does the export emit -- the raw SFFS body, or the whole VFSI
    /// container?
    ///
    /// It emitted a BODY, and this test pinned that, because the answer decided
    /// whether the bridge had to wrap the bytes before writing a `.vfs` file.
    /// The answer was "yes", which meant the host would have been assembling
    /// the container: a second author for the format this lane exists to give
    /// one, and the same shape of defect as the two descriptions V4 spent its
    /// increments collapsing.
    ///
    /// It emits a container now. The assertions are inverted rather than
    /// deleted, so the question this test was written to answer stays answered.
    /// Drain the whole exported container.
    ///
    /// **Bounded on purpose.** These loops were written to stop when the export
    /// returns 0, which is correct until a defect stops it returning 0 — and a
    /// mutation trial did exactly that, making the export ignore its offset and
    /// restart forever. The test span for eighteen minutes growing a buffer
    /// instead of failing, and the mutation harness waited on it because
    /// nothing bounded either side.
    ///
    /// A test that hangs is worse than one that fails: it costs the whole run
    /// and says nothing about what broke. The cap is far above any image these
    /// tests build, so it can only be hit by non-termination.
    fn drain_export() -> alloc::vec::Vec<u8> {
        const CHUNK: usize = 64 * 1024;
        // These images are kilobytes. A megabyte means the export is not
        // advancing.
        const SANE_LIMIT: usize = 4 * 1024 * 1024;
        let buf = sm_alloc(CHUNK);
        let mut image: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let mut offset = 0i64;
        loop {
            let n = unsafe { sm_export_image_read(offset, buf, CHUNK) };
            assert!(n >= 0, "export failed at offset {offset}: {n}");
            if n == 0 {
                break;
            }
            let got = unsafe { core::slice::from_raw_parts(buf as *const u8, n as usize) };
            image.extend_from_slice(got);
            offset += n as i64;
            assert!(
                image.len() <= SANE_LIMIT,
                "the export is not advancing: {} bytes drained from a tiny image, so \
                 some chunk is being served again instead of the next one",
                image.len(),
            );
        }
        unsafe { sm_free(buf, CHUNK) };
        image
    }

    #[test]
    fn the_export_emits_a_whole_container_not_a_bare_body() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/usr", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        assert_eq!(
            with_two(b"/usr/hello", b"hi", |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o644, cp, cl)
            }),
            0
        );

        let image = drain_export();
        assert!(!image.is_empty(), "the export must produce bytes");

        // The decisive check: these bytes are a container, so a bare mount
        // fails and unwrapping succeeds. Both directions, because "it mounts"
        // alone would also pass for a body.
        assert!(
            runtime_core::sffs::Sffs::mount(image.clone()).is_err(),
            "a container is not a bare body",
        );
        let body = runtime_core::sffs::unwrap_vfsi(&image)
            .expect("the export emits a whole VFSI container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount the body inside it");

        // And the tree that comes back is the tree that was built.
        let ino = fs.resolve(b"/usr/hello", true).expect("resolve /usr/hello");
        let st = fs.stat_ino(ino).expect("stat");
        assert_eq!(st.mode & 0o7777, 0o644);
        assert_eq!(st.size, 2);
        let mut back = [0u8; 2];
        fs.read_at(ino, 0, &mut back).expect("read");
        assert_eq!(&back, b"hi", "the exported image carries the content written through the ABI");

        // No metadata was set, so the container declares none rather than
        // carrying an empty section nothing claims.
        assert!(
            runtime_core::sffs::metadata_section(&image).expect("walk") .is_none(),
            "no metadata in, no metadata section out",
        );
    }

    #[test]
    fn image_metadata_set_through_the_abi_reaches_the_exported_container() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let metadata = br#"{"version":1,"kernelAbi":44,"createdBy":"a test"}"#;
        assert_eq!(
            with_path(metadata, |p, l| unsafe { sm_set_image_options(0, p, l) }),
            0
        );

        let image = drain_export();

        assert_eq!(
            runtime_core::sffs::metadata_section(&image)
                .expect("walk")
                .expect("the container declares a metadata section"),
            metadata,
            "carried through byte for byte, never parsed",
        );

        // Clearing it removes the section rather than leaving an empty one.
        assert_eq!(unsafe { sm_set_image_options(0, 0, 0) }, 0);
        let cleared = drain_export();
        assert!(runtime_core::sffs::metadata_section(&cleared).expect("walk").is_none());
    }

    /// **Driving the export over base files DESTROYS them, and this test pins
    /// that so nobody wires derived builds through it by accident.**
    ///
    /// Reached by trying to assert three different things and being wrong each
    /// time: first that exporting unreachable base content would FAIL (it
    /// completes), then that the exported file would carry its real size (the
    /// body inode is a stub), then that a deferred record would carry the size
    /// instead (there is no deferred section at all).
    ///
    /// What actually happens is lane V's V4 hazard, quoted in the master plan:
    /// "V4 would silently destroy every lazy file if routed through
    /// `export_image_read` without the identity contract: 65 files in the base
    /// image, 79 in a derived one, each surviving as a zero-byte regular file
    /// with no URL."
    ///
    /// So this module is correct for FRESH builds, which have no base files,
    /// and is NOT yet usable for DERIVED builds. The identity contract has to
    /// be supplied before it is, and a test asserting the damage is the only
    /// honest way to hold that boundary: the failure is invisible otherwise,
    /// because the image builds, mounts, and boots.
    #[test]
    fn exporting_a_base_file_silently_empties_it_todo_derived_builds() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        rootfs::insert_base_file(b"/base.bin", 42, 4096, 0o644, 0, 0, 9).expect("insert base");

        let image = drain_export();

        let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a real container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount the exported image");
        let ino = fs.resolve(b"/base.bin", false).expect("the path survives");
        let st = fs.stat_ino(ino).expect("stat");

        assert_eq!(st.size, 0, "THE DAMAGE: a 4096-byte file exports as zero-length");
        // The image now always carries a deferred section, because an image
        // that carries none is one the kernel refuses to load (gap 15). So the
        // damage is no longer "there is no section" but "the section does not
        // mention this inode" — which is the same loss stated against a
        // carrier that exists. A blob-backed base file has no identity the
        // kernel could write down; that is the master plan's items 2 and 3,
        // and it is still open.
        let section = fs.deferred_section().expect("decodes").expect("a section");
        assert!(
            !section.records.iter().any(|r| r.ino == ino),
            "THE DAMAGE: no deferred record, so nothing records where its bytes were",
        );
    }

    /// **A registered lazy file exports as a deferred record carrying its real
    /// size and its archive linkage.** This test was written the other way up:
    /// it pinned the damage, because `build_export_image` mapped
    /// `InodeKind::LazyMember` to an empty file and emitted no deferred record,
    /// so a 99,999-byte member exported as a zero-length file with no trace of
    /// where its bytes were. That made `export_image_read` unable to serialize
    /// a production image at all -- not merely a derived one, since fresh
    /// builds REGISTER lazy files and the shipped shell image carries 7,546
    /// deferred entries.
    ///
    /// Lane V's V4 closed it for this arm. The assertions are inverted rather
    /// than deleted, so the test still names the defect it was written for and
    /// a regression reads as "the damage is back" rather than as an unfamiliar
    /// failure.
    ///
    /// **The body inode is still zero-length, and that is the point**: the
    /// image DESCRIBES bytes it does not contain. Materializing them here is
    /// what would make a 249 MiB image impossible.
    #[test]
    fn a_registered_lazy_file_exports_as_deferred_with_its_real_size() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/usr", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);

        let rc = with_two(b"/usr/big", b"members/big.bin", |pp, pl, sp, sl| unsafe {
            sm_register_lazy_file(pp, pl, 3, sp, sl, 99_999, 0o755, 0, 0, 40, 8_000_000, 0, 0, 0, 0, 0, 0, 0)
        });
        assert_eq!(rc, 0);

        // Registration is correct: the metadata is right before any fetch.
        let st = rootfs::lstat(b"/usr/big").expect("lazy file exists");
        assert_eq!(st.st_size, 99_999, "the manifest size is authoritative pre-fetch");
        assert_eq!(st.st_mode & 0o7777, 0o755);

        let image = drain_export();

        let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a real container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount");
        let ino = fs.resolve(b"/usr/big", false).expect("the path survives");
        assert_eq!(
            fs.stat_ino(ino).expect("stat").size,
            0,
            "the body inode is a stub -- the image describes bytes it does not carry",
        );

        let section = fs
            .deferred_section()
            .expect("decodes")
            .expect("the export emits a deferred section");
        let record = section
            .get(ino)
            .expect("a record for the exported inode, keyed by its NEW number");
        assert_eq!(
            record.size, 99_999,
            "the real size rides in the record, not in the body inode",
        );
        assert_eq!(record.archive_id, 3, "which archive backs it");
        assert_eq!(
            record.source_path, b"members/big.bin",
            "and which member within that archive",
        );
        // The record is keyed on the inode the EXPORT assigned, which is the
        // whole reason this linkage cannot be carried by inode number across a
        // rewrite: nothing guarantees it matches the number it was registered
        // under.
        assert_eq!(section.len(), 1, "one deferred file, one record");

        // And the archive's own length is carried forward, from the table this
        // kernel loaded rather than invented. Without it a consumer of the
        // exported image knows which archive to fetch but not how much of it to
        // read, which is the same defect as losing the linkage entirely.
        assert_eq!(
            section.archive_bytes(3),
            Some(8_000_000),
            "the exported section declares the archive its record points into",
        );
    }

    #[test]
    fn a_file_fetched_standalone_registers_and_exports_with_its_description() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/usr", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);

        // No archive: `archive_id == 0`, no member path, and the payload is the
        // whole of what says where the bytes are. This is the shape 79 files in
        // the shipped shell image have, and the shape lane S's setuid defect is
        // about — and it was NOT registrable through this entry point before,
        // because the archive declaration it went through refuses id 0.
        let url: &[u8] = b"https://example.invalid/sudo#sha256:feedface";
        let rc = with_two(b"/usr/sudo", url, |pp, pl, up, ul| unsafe {
            sm_register_lazy_file(pp, pl, 0, 0, 0, 99_999, 0o4755, 0, 0, 40, 0, up, ul, 0, 0, 0, 0, 0)
        });
        assert_eq!(rc, 0, "a standalone-fetch file registers");

        // Its metadata is right before any fetch, setuid bit included.
        let st = rootfs::lstat(b"/usr/sudo").expect("exists");
        assert_eq!(st.st_size, 99_999);
        assert_eq!(st.st_mode & 0o7777, 0o4755);

        let image = drain_export();
        let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount");
        let ino = fs.resolve(b"/usr/sudo", false).expect("the path survives");
        let record = fs
            .deferred_section()
            .expect("decodes")
            .expect("a deferred section")
            .get(ino)
            .cloned()
            .expect("a record for it");

        assert_eq!(record.size, 99_999, "the real size rides in the record");
        assert_eq!(record.archive_id, 0, "fetched standalone");
        assert!(record.source_path.is_empty(), "so with no member path");
        assert_eq!(
            record.payload, url,
            "and the description carried through byte for byte — this is where a \
             digest for a setuid binary would live",
        );
    }

    #[test]
    fn an_archive_member_and_a_standalone_file_can_share_one_image() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let rc = with_two(b"/member", b"members/x", |pp, pl, sp, sl| unsafe {
            sm_register_lazy_file(pp, pl, 3, sp, sl, 10, 0o644, 0, 0, 40, 8_000_000, 0, 0, 0, 0, 0, 0, 0)
        });
        assert_eq!(rc, 0);
        let url: &[u8] = b"https://example.invalid/solo";
        let rc = with_two(b"/solo", url, |pp, pl, up, ul| unsafe {
            sm_register_lazy_file(pp, pl, 0, 0, 0, 20, 0o644, 0, 0, 41, 0, up, ul, 0, 0, 0, 0, 0)
        });
        assert_eq!(rc, 0);

        let image = drain_export();
        let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount");
        let section = fs.deferred_section().expect("decodes").expect("section");
        assert_eq!(section.len(), 2, "both are described");

        // One archive declared, for the member that needs it — and not one for
        // the standalone file, which has no archive to declare.
        assert_eq!(section.archives.len(), 1);
        assert_eq!(section.archive_bytes(3), Some(8_000_000));

        let member = fs.resolve(b"/member", false).expect("member");
        let solo = fs.resolve(b"/solo", false).expect("solo");
        assert_eq!(section.get(member).expect("member record").archive_id, 3);
        assert_eq!(section.get(solo).expect("solo record").archive_id, 0);
        assert_eq!(section.get(solo).expect("solo record").payload, url);
    }

    #[test]
    fn the_export_reports_its_own_growth_ceiling() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);

        let buf = sm_alloc(40);
        assert_eq!(unsafe { sm_check_headroom(0, 0, buf, 40) }, 0);
        let bytes = unsafe { core::slice::from_raw_parts(buf as *const u8, 40) };
        let ceiling =
            u64::from_le_bytes(bytes[32..40].try_into().expect("8")) as i64;
        unsafe { sm_free(buf, 40) };
        assert!(ceiling > 0, "a real ceiling: {ceiling}");

        // It is the ceiling the EXPORTED IMAGE declares, so reading the bytes
        // back must agree. That is the property the builders assert, and
        // checking it here is what makes asking the producer equivalent to
        // parsing the artifact.
        let image = drain_export();
        let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount");
        assert_eq!(
            fs.growth_ceiling_bytes().expect("ceiling"),
            ceiling as u64,
            "the producer's answer and the artifact's own header agree",
        );
    }

    #[test]
    fn a_requested_capacity_raises_the_ceiling_without_shrinking_the_image() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);

        let ceiling_of = || -> u64 {
            let image = drain_export();
            let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a container");
            runtime_core::sffs::Sffs::mount(body)
                .expect("mount")
                .growth_ceiling_bytes()
                .expect("ceiling")
        };

        // Without a request the export sizes to its own tree — gap 14's
        // starting condition, and why a declared capacity was unmeetable.
        let unrequested = ceiling_of();

        // A request raises it. This is the number a product declares and its
        // publication gate checks the artifact against.
        assert_eq!(unsafe { sm_set_image_options(64 * 1024 * 1024, 0, 0) }, 0);
        let requested = ceiling_of();
        assert!(
            requested >= 64 * 1024 * 1024,
            "the declared capacity is met: {requested}",
        );
        assert!(requested > unrequested, "and it is a raise, not a coincidence");

        // A request SMALLER than the tree needs is a floor, not a size: the
        // tree's own requirement still wins, because an image that cannot hold
        // its contents is not a smaller image, it is a broken one.
        assert_eq!(unsafe { sm_set_image_options(1, 0, 0) }, 0);
        assert_eq!(
            ceiling_of(),
            unrequested,
            "a request below the tree's requirement changes nothing",
        );

        // And zero clears it.
        assert_eq!(unsafe { sm_set_image_options(0, 0, 0) }, 0);
        assert_eq!(ceiling_of(), unrequested);
    }

    /// Hand an image to the module the way the host will: allocate, copy,
    /// transfer. Returns the entry count `sm_load_image` reported.
    fn load_image_bytes(image: &[u8]) -> i32 {
        let ptr = sm_alloc(image.len());
        assert_ne!(ptr, 0, "allocation for a {}-byte image", image.len());
        unsafe { core::ptr::copy_nonoverlapping(image.as_ptr(), ptr as *mut u8, image.len()) };
        // Ownership transfers on success; nothing here frees it.
        unsafe { sm_load_image(ptr, image.len()) }
    }

    #[test]
    fn an_image_this_module_exported_is_one_it_can_load_back() {
        // The round trip is the whole claim of the bridge: a builder writes a
        // tree, saves it, and a DERIVED build starts from what was saved. If
        // the load cannot read what the export wrote, the two halves are not
        // one format and every derived build is building on sand.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/etc", b"", |pp, pl, _c, _l| unsafe {
            sm_mkdir(pp, pl, 0o755, 0, 0)
        }), 0);
        assert_eq!(with_two(b"/etc/motd", b"be excellent", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        assert_eq!(with_two(b"/link", b"/etc/motd", |pp, pl, tp, tl| unsafe {
            sm_symlink(tp, tl, pp, pl, 0, 0)
        }), 0);
        let image = drain_export();

        // A DIFFERENT filesystem: reset first, so nothing below can be
        // answered by the tree that is still in memory.
        sm_reset(0o755, 0, 0);
        let entries = load_image_bytes(&image);
        assert!(entries > 0, "load reported {entries} for a {}-byte image", image.len());

        let stat_of = |path: &[u8]| -> [u64; 8] {
            let size = unsafe { sm_lstat(0, 0, 0, 0) } as usize;
            let buf = sm_alloc(size);
            let (pp, pl) = write_path(path);
            let rc = unsafe { sm_lstat(pp, pl, buf, size) };
            assert_eq!(rc, 0, "lstat {}", alloc::string::String::from_utf8_lossy(path));
            let bytes = unsafe { core::slice::from_raw_parts(buf as *const u8, size) };
            let mut out = [0u64; 8];
            for (i, slot) in out.iter_mut().enumerate() {
                let mut w = [0u8; 8];
                w.copy_from_slice(&bytes[i * 8..i * 8 + 8]);
                *slot = u64::from_le_bytes(w);
            }
            unsafe { sm_free(pp, pl) };
            unsafe { sm_free(buf, size) };
            out
        };

        assert_eq!(stat_of(b"/etc/motd")[5], 12, "the file's size came back");
        assert_eq!(stat_of(b"/etc/motd")[1] & 0o777, 0o644, "and its mode");
        assert_eq!(stat_of(b"/etc")[1] & 0o170000, 0o040000, "/etc is a directory");
        assert_eq!(stat_of(b"/link")[1] & 0o170000, 0o120000, "/link is a symlink");

        // The bytes, not just the metadata. A load that rebuilt the tree but
        // lost its content would satisfy every assertion above.
        let (pp, pl) = write_path(b"/etc/motd");
        let buf = sm_alloc(64);
        let n = unsafe { sm_read_file(pp, pl, 0, buf, 64) };
        assert_eq!(n, 12, "read back {n}");
        let got = unsafe { core::slice::from_raw_parts(buf as *const u8, 12) };
        assert_eq!(got, b"be excellent", "the content survived the round trip");
        unsafe { sm_free(pp, pl) };
        unsafe { sm_free(buf, 64) };
    }

    #[test]
    fn a_derived_export_carries_the_base_image_content_it_did_not_write() {
        // The derived case: load an image, change one thing, export. Every file
        // the builder did NOT touch must still export with its real bytes, and
        // those bytes live in the loaded image rather than in any tree this
        // module built. Before the load existed, the export's byte source was a
        // hardcoded EIO and this was unreachable.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/base", b"from the base image", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        let base = drain_export();

        sm_reset(0o755, 0, 0);
        assert!(load_image_bytes(&base) > 0);
        assert_eq!(with_two(b"/added", b"by the derived build", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        let derived = drain_export();

        sm_reset(0o755, 0, 0);
        assert!(load_image_bytes(&derived) > 0);
        let read = |path: &[u8], want: &[u8]| {
            let (pp, pl) = write_path(path);
            let buf = sm_alloc(64);
            let n = unsafe { sm_read_file(pp, pl, 0, buf, 64) };
            assert_eq!(n as usize, want.len(), "reading {}", alloc::string::String::from_utf8_lossy(path));
            let got = unsafe { core::slice::from_raw_parts(buf as *const u8, want.len()) };
            assert_eq!(got, want);
            unsafe { sm_free(pp, pl) };
            unsafe { sm_free(buf, 64) };
        };
        read(b"/base", b"from the base image");
        read(b"/added", b"by the derived build");
    }

    #[test]
    fn a_refused_image_leaves_its_buffer_with_the_host() {
        // The ownership contract's dangerous half. On failure the host still
        // owns what it allocated -- so the module must not have adopted it, or
        // the host's own free is a double free. Observable here as: a refused
        // load leaves NOTHING loaded, so a later export cannot serve base bytes
        // out of a buffer the host is entitled to reuse.
        sm_reset(0o755, 0, 0);
        let junk = alloc::vec![0xABu8; 4096];
        let ptr = sm_alloc(junk.len());
        unsafe { core::ptr::copy_nonoverlapping(junk.as_ptr(), ptr as *mut u8, junk.len()) };
        let rc = unsafe { sm_load_image(ptr, junk.len()) };
        assert!(rc < 0, "4 KiB of 0xAB is not an image: {rc}");
        // The host frees it, as the contract says it may. If the module had
        // adopted it, this and the module's own free would both run.
        unsafe { sm_free(ptr, junk.len()) };
        assert!(image_bytes().is_none(), "nothing is loaded after a refusal");
    }

    #[test]
    fn the_record_length_is_answerable_without_a_path() {
        // The convention that let `sm_stat_size` go. A caller with no path yet
        // -- which is every caller, before its first lstat -- can still size
        // its buffer.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(unsafe { sm_lstat(0, 0, 0, 0) }, 64, "eight u64s");
        // And a path that does not exist does not change the answer, because
        // the probe is answered before the path is consulted.
        let (pp, pl) = write_path(b"/nowhere");
        assert_eq!(unsafe { sm_lstat(pp, pl, 0, 0) }, 64);
        unsafe { sm_free(pp, pl) };
        // While a real call with a too-small buffer is still refused -- on a
        // path that EXISTS, because the ordering is probe, then path, then
        // buffer: a missing path is ENOENT before the size is ever considered.
        let (pp, pl) = write_path(b"/");
        let buf = sm_alloc(8);
        assert_eq!(unsafe { sm_lstat(pp, pl, buf, 8) }, -(Errno::EINVAL as i32));
        unsafe { sm_free(buf, 8) };
        unsafe { sm_free(pp, pl) };
    }

    #[test]
    fn the_byte_source_serves_the_image_and_only_the_image() {
        // `image_source` is the module's whole answer to "where do bytes come
        // from", and every caller reaches it through several layers. Tested
        // directly, because the boundaries that matter -- what it refuses, and
        // what it does at the end of the image -- are hard to steer a builder
        // into and trivial to state here.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        let image = drain_export();
        let len = image.len();

        // Nothing loaded: a request cannot be served, and must not be answered
        // with silence that reads like an empty file.
        sm_reset(0o755, 0, 0);
        let mut buf = [0u8; 16];
        assert_eq!(
            image_source(rootfs::ByteReq::Image { offset: 0 }, &mut buf),
            Err(Errno::EIO),
            "no image loaded is a failure, not zero bytes",
        );

        assert!(load_image_bytes(&image) > 0);

        // The image, from the front.
        let mut head = [0u8; 8];
        assert_eq!(image_source(rootfs::ByteReq::Image { offset: 0 }, &mut head), Ok(8));
        assert_eq!(head, image[..8], "the bytes are the image's own");

        // At the end: a short count, not a full buffer of whatever follows.
        let mut tail = [0u8; 64];
        let want = 10;
        let n = image_source(
            rootfs::ByteReq::Image { offset: (len - want) as u64 },
            &mut tail,
        );
        assert_eq!(n, Ok(want), "a read straddling the end is short, not full");
        assert_eq!(&tail[..want], &image[len - want..]);
        // Past the end: nothing, and not an error -- a reader walking off the
        // end has reached the end.
        assert_eq!(
            image_source(rootfs::ByteReq::Image { offset: len as u64 }, &mut tail),
            Ok(0),
        );

        // And the requests this module cannot serve stay unserved. A blob or
        // an archive is a HOST transport; answering one out of the image would
        // hand back whatever bytes happen to sit at that offset, which is the
        // most dangerous possible wrong answer because it looks like data.
        assert_eq!(
            image_source(rootfs::ByteReq::Base { blob_id: 1, offset: 0 }, &mut buf),
            Err(Errno::EIO),
        );
        assert_eq!(
            image_source(rootfs::ByteReq::Archive { archive_id: 1, offset: 0 }, &mut buf),
            Err(Errno::EIO),
        );
    }

    #[test]
    fn a_blob_backed_file_is_not_read_out_of_the_loaded_image() {
        // The same refusal, reached the way a builder would reach it. A base
        // file whose bytes live in a host blob keeps its blob id after a load;
        // if the byte source treated that id's offset as an image offset, the
        // read would succeed and return unrelated bytes from the middle of the
        // image.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        let image = drain_export();
        sm_reset(0o755, 0, 0);
        assert!(load_image_bytes(&image) > 0);

        rootfs::insert_base_file(b"/blob.bin", 7, 4096, 0o644, 0, 0, 99).expect("base file");
        let (pp, pl) = write_path(b"/blob.bin");
        let buf = sm_alloc(64);
        let rc = unsafe { sm_read_file(pp, pl, 0, buf, 64) };
        assert_eq!(rc, -(Errno::EIO as i32), "a blob is a host transport, not an offset");
        unsafe { sm_free(pp, pl) };
        unsafe { sm_free(buf, 64) };
    }

    #[test]
    fn an_image_that_is_replaced_or_reset_is_freed() {
        // The adopted buffer is the one allocation here whose lifetime
        // outlives its call, so it is the one that can leak -- and a leak has
        // no direct observation. A FREE does: the allocator can hand the region
        // back.
        //
        // An earlier version asserted exact address equality after one replace.
        // That was too coupled to the allocator's state: folding an inode
        // allocation into `sm_reset` moved the addresses and broke a test whose
        // subject had not changed. Counting DISTINCT adopted addresses across
        // many loads says the same thing without depending on which address
        // comes back. Each load allocates the new image BEFORE releasing the
        // old, so a freeing implementation ping-pongs between two regions and
        // a leaking one climbs forever.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        let image = drain_export();

        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let mut seen: alloc::vec::Vec<usize> = alloc::vec::Vec::new();
        for _ in 0..8 {
            assert!(load_image_bytes(&image) > 0);
            let at = image_bytes().expect("loaded").as_ptr() as usize;
            if !seen.contains(&at) {
                seen.push(at);
            }
        }
        assert!(
            seen.len() <= 2,
            "eight loads used {} distinct regions; a load that frees the image \
             it replaces reuses them",
            seen.len(),
        );

        // And a reset frees the last one, so the next load can have it back.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert!(image_bytes().is_none(), "nothing is loaded after a reset");
        assert!(load_image_bytes(&image) > 0);
        let after_reset = image_bytes().expect("loaded").as_ptr() as usize;
        assert!(
            seen.contains(&after_reset),
            "the reset released its image, so the next load reused a region",
        );
    }

    #[test]
    fn an_empty_range_is_not_an_image() {
        sm_reset(0o755, 0, 0);
        let ptr = sm_alloc(16);
        assert_eq!(unsafe { sm_load_image(ptr, 0) }, -(Errno::EINVAL as i32));
        assert_eq!(unsafe { sm_load_image(0, 16) }, -(Errno::EINVAL as i32));
        assert!(image_bytes().is_none());
        unsafe { sm_free(ptr, 16) };

        // The return code is not what the guard is for. A zero-length range
        // would fail the load anyway -- there is no container in no bytes --
        // so refusing it early changes no answer. What it changes is that the
        // refusal happens BEFORE `release_image`, so a malformed call cannot
        // destroy the image already loaded. Without that, any caller that
        // passed a truncated buffer would silently empty the base layer and
        // then get an error that says nothing about what it cost.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        let image = drain_export();
        sm_reset(0o755, 0, 0);
        assert!(load_image_bytes(&image) > 0);
        let loaded = image_bytes().expect("loaded").as_ptr() as usize;

        let ptr = sm_alloc(16);
        assert_eq!(unsafe { sm_load_image(ptr, 0) }, -(Errno::EINVAL as i32));
        assert_eq!(
            image_bytes().expect("still loaded").as_ptr() as usize,
            loaded,
            "a refused load left the loaded image alone",
        );
        unsafe { sm_free(ptr, 16) };
    }

    #[test]
    fn a_failed_export_reports_the_failure_rather_than_a_byte_count() {
        // A zero return from `sm_export_image_read` means "the image ends
        // here", so an error reported as 0 is an error reported as SUCCESS --
        // the host writes a truncated image and nothing says otherwise.
        //
        // This used to reach the failure by exporting with no root inode.
        // Folding `sm_init_root` into `sm_reset` made that state unreachable,
        // which is the fold working as intended and not a loss: a negative
        // offset is a failure a real caller can actually produce, by carrying
        // a cursor that went wrong.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let buf = sm_alloc(4096);
        let rc = unsafe { sm_export_image_read(-1, buf, 4096) };
        assert!(rc < 0, "a negative offset is a failure, got {rc}");
        unsafe { sm_free(buf, 4096) };
    }

    #[test]
    fn declaring_room_is_not_occupying_it() {
        // The maintainer's rule, stated rather than assumed: "an image of
        // capacity X should only take the size of its contents in memory when
        // loaded. It should not take X in memory right away unless it is
        // filled to capacity X already."
        //
        // This held before it was written down, and would have been lost
        // quietly: the capacity test declares 64 MiB and passes only because
        // `drain_export` gives up past 4 MiB, so a regression would have
        // surfaced as a confusing drain failure rather than as this sentence.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        assert_eq!(unsafe { sm_set_image_options(64 * 1024 * 1024, 0, 0) }, 0);

        let image = drain_export();
        let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount");

        assert!(
            fs.growth_ceiling_bytes().expect("ceiling") >= 64 * 1024 * 1024,
            "the room is declared",
        );
        // And not taken. The one cost that IS proportional is the inode table,
        // which grows as `max_blocks / 4` -- about 2 MiB for this declaration,
        // which is why the bound is generous rather than zero. It is still two
        // orders of magnitude below the declared room.
        assert!(
            image.len() < 4 * 1024 * 1024,
            "a five-byte tree declaring 64 MiB exported {} bytes",
            image.len(),
        );
    }

    #[test]
    fn a_load_keeps_what_the_image_says_about_itself() {
        // Gap 16. Both of these were written only by their setters and read
        // only by the export, so an image loaded and re-exported came back
        // having forgotten its own declarations.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        let meta = b"{\"kernelAbi\":44,\"createdBy\":\"the test\"}";
        let mp = sm_alloc(meta.len());
        unsafe { core::ptr::copy_nonoverlapping(meta.as_ptr(), mp as *mut u8, meta.len()) };
        assert_eq!(unsafe { sm_set_image_options(64 * 1024 * 1024, mp, meta.len()) }, 0);
        unsafe { sm_free(mp, meta.len()) };
        let original = drain_export();

        // A DIFFERENT filesystem, with nothing declared on it.
        sm_reset(0o755, 0, 0);
        assert!(load_image_bytes(&original) > 0);
        let rewritten = drain_export();

        let body = runtime_core::sffs::unwrap_vfsi(&rewritten).expect("a container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount");
        assert!(
            fs.growth_ceiling_bytes().expect("ceiling") >= 64 * 1024 * 1024,
            "the declared capacity survived the load",
        );
        assert_eq!(
            runtime_core::sffs::metadata_span(&rewritten.as_slice())
                .expect("span")
                .map(|(offset, len)| {
                    let start = offset as usize;
                    rewritten[start..start + len as usize].to_vec()
                })
                .as_deref(),
            Some(&meta[..]),
            "and so did the metadata the image declared",
        );

        // And the room is still declared rather than taken.
        assert!(
            rewritten.len() < 4 * 1024 * 1024,
            "the re-export took {} bytes",
            rewritten.len(),
        );
    }

    #[test]
    fn the_metadata_can_be_read_back_including_an_image_the_builder_never_set() {
        // Six builder call sites read this, and every one of them is a GUARD:
        // they compare the base image's declared `kernelAbi` against what the
        // build expects. A guard must read the base's real answer, not the
        // builder's memory of what it set -- and after a load the builder set
        // nothing at all.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(unsafe { sm_image_metadata(0, 0) }, 0, "nothing declared yet");

        let meta = b"{\"version\":1,\"kernelAbi\":44}";
        let mp = sm_alloc(meta.len());
        unsafe { core::ptr::copy_nonoverlapping(meta.as_ptr(), mp as *mut u8, meta.len()) };
        assert_eq!(unsafe { sm_set_image_options(0, mp, meta.len()) }, 0);
        unsafe { sm_free(mp, meta.len()) };

        let read = |expect: &[u8]| {
            let size = unsafe { sm_image_metadata(0, 0) } as usize;
            assert_eq!(size, expect.len(), "the probe reports the record's length");
            let buf = sm_alloc(size);
            let n = unsafe { sm_image_metadata(buf, size) };
            assert_eq!(n as usize, size);
            let got = unsafe { core::slice::from_raw_parts(buf as *const u8, size) };
            assert_eq!(got, expect, "the bytes come back exactly as given");
            unsafe { sm_free(buf, size) };
        };
        read(meta);

        // The case the entry point exists for: a DIFFERENT filesystem, which
        // declared nothing, reading what an image declared.
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);
        let image = drain_export();
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(unsafe { sm_image_metadata(0, 0) }, 0, "and it starts empty");
        assert!(load_image_bytes(&image) > 0);
        read(meta);

        // A buffer too small is refused rather than truncating an answer a
        // caller would then parse as JSON and get a confusing error from.
        let small = sm_alloc(4);
        assert_eq!(
            unsafe { sm_image_metadata(small, 4) },
            -(Errno::EINVAL as i32),
        );
        unsafe { sm_free(small, 4) };
    }

    #[test]
    fn reset_gives_the_root_the_ownership_and_mode_it_was_handed() {
        // A surviving mutant: `sm_reset` took a root mode, uid and gid, and
        // nothing asserted that any of the three reached the inode. Every test
        // passed 0o755 and then looked at some OTHER path's mode, so a reset
        // that hardcoded its root would have gone unnoticed -- and a root with
        // the wrong mode is a permission boundary silently in the wrong place
        // at the top of every image built afterwards.
        //
        // Reachable only since the fold: creating the root used to be
        // `sm_init_root`'s job, and this is the coverage that did not move
        // across with it.
        assert_eq!(sm_reset(0o751, 7, 11), 0);

        let size = unsafe { sm_lstat(0, 0, 0, 0) } as usize;
        let buf = sm_alloc(size);
        let (pp, pl) = write_path(b"/");
        assert_eq!(unsafe { sm_lstat(pp, pl, buf, size) }, 0);
        let bytes = unsafe { core::slice::from_raw_parts(buf as *const u8, size) };
        let field = |i: usize| {
            let mut w = [0u8; 8];
            w.copy_from_slice(&bytes[i * 8..i * 8 + 8]);
            u64::from_le_bytes(w)
        };
        assert_eq!(field(1) & 0o7777, 0o751, "the root carries the mode given");
        assert_eq!(field(1) & 0o170000, 0o040000, "and is a directory");
        assert_eq!(field(3), 7, "and the uid");
        assert_eq!(field(4), 11, "and the gid");
        unsafe { sm_free(pp, pl) };
        unsafe { sm_free(buf, size) };
    }

    /// Register one member of `archive_id`, carrying `descriptor` (possibly
    /// empty) as the archive's fetch description.
    fn register_member(path: &[u8], archive_id: u32, source: &[u8], descriptor: &[u8]) -> i32 {
        let (pp, pl) = write_path(path);
        let (sp, sl) = write_path(source);
        let dp = if descriptor.is_empty() { 0 } else { sm_alloc(descriptor.len()) };
        if dp != 0 {
            unsafe {
                core::ptr::copy_nonoverlapping(descriptor.as_ptr(), dp as *mut u8, descriptor.len())
            };
        }
        let rc = unsafe {
            sm_register_lazy_file(
                pp, pl, archive_id, sp, sl, 99, 0o644, 0, 0, 4_000_000, 4096, dp, descriptor.len(),
                     0, 0, 0, 0, 0,
                )
        };
        unsafe { sm_free(pp, pl) };
        unsafe { sm_free(sp, sl) };
        if dp != 0 {
            unsafe { sm_free(dp, descriptor.len()) };
        }
        rc
    }

    /// Register a member of an archive that also DECLARES its cohort.
    fn register_cohort_member(
        path: &[u8],
        archive_id: u32,
        source: &[u8],
        descriptor: &[u8],
        cohort: &[u8],
        member: &[u8],
        expected_count: u32,
    ) -> i32 {
        let (pp, pl) = write_path(path);
        let (sp, sl) = write_path(source);
        let (dp, dl) = write_path(descriptor);
        let (cp, cl) = write_path(cohort);
        let (mp, ml) = write_path(member);
        let rc = unsafe {
            sm_register_lazy_file(
                pp, pl, archive_id, sp, sl, 99, 0o644, 0, 0, 4_000_000, 4096, dp, dl,
                cp, cl, mp, ml, expected_count,
            )
        };
        for (ptr, len) in [(pp, pl), (sp, sl), (dp, dl), (cp, cl), (mp, ml)] {
            unsafe { sm_free(ptr, len) };
        }
        rc
    }

    /// A root with one directory, ready for archive members.
    fn fresh_tree() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/opt", b"", |pp, pl, _c, _l| unsafe {
            sm_mkdir(pp, pl, 0o755, 0, 0)
        }), 0);
    }

    #[test]
    fn a_declared_cohort_is_sealed_at_export_and_loads_back() {
        // The producer half, end to end. A builder DECLARES membership and
        // never computes a digest -- it cannot, because the cohort digest
        // covers every member and the last one is not known while the first is
        // being registered. The module completes the seal at the export door,
        // and the verifier on the way back in accepts it.
        fresh_tree();
        assert_eq!(
            register_cohort_member(b"/opt/a", 1, b"a", b"{\"url\":\"https://x/a.zip\"}",
                                   b"shell", b"tools", 2),
            0,
        );
        assert_eq!(
            register_cohort_member(b"/opt/b", 2, b"b", b"{\"url\":\"https://x/b.zip\"}",
                                   b"shell", b"docs", 2),
            0,
        );
        let image = drain_export();

        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert!(load_image_bytes(&image) > 0, "a sealed cohort authenticates");
    }

    #[test]
    fn a_cohort_short_of_its_declared_count_is_refused_at_export() {
        // The count is why `Pending` carries one. Deriving it from the pending
        // members instead would seal a cohort of one that was meant to be two,
        // every digest would agree, and the verifier would accept an image that
        // can only activate partially -- which is the thing atomic activation
        // exists to prevent.
        fresh_tree();
        assert_eq!(
            register_cohort_member(b"/opt/a", 1, b"a", b"{\"url\":\"https://x/a.zip\"}",
                                   b"shell", b"tools", 2),
            0,
        );
        let buf = sm_alloc(4096);
        assert_eq!(
            unsafe { sm_export_image_read(0, buf, 4096) },
            -(Errno::EINVAL as i32),
            "the producer refuses to emit a cohort it cannot complete",
        );
        unsafe { sm_free(buf, 4096) };
    }

    #[test]
    fn members_of_one_cohort_must_agree_about_its_size() {
        // Believing either count would pick the answer by declaration order.
        fresh_tree();
        assert_eq!(
            register_cohort_member(b"/opt/a", 1, b"a", b"{\"url\":\"https://x/a.zip\"}",
                                   b"shell", b"tools", 2),
            0,
        );
        assert_eq!(
            register_cohort_member(b"/opt/b", 2, b"b", b"{\"url\":\"https://x/b.zip\"}",
                                   b"shell", b"docs", 3),
            0,
        );
        let buf = sm_alloc(4096);
        assert_eq!(unsafe { sm_export_image_read(0, buf, 4096) }, -(Errno::EINVAL as i32));
        unsafe { sm_free(buf, 4096) };
    }

    #[test]
    fn two_archives_cannot_share_one_member_name() {
        // The cohort identity is digested over the member NAMES, so two
        // archives answering to one name make that identity ambiguous: the same
        // bytes would describe two different sets of archives.
        fresh_tree();
        assert_eq!(
            register_cohort_member(b"/opt/a", 1, b"a", b"{\"url\":\"https://x/a.zip\"}",
                                   b"shell", b"tools", 2),
            0,
        );
        assert_eq!(
            register_cohort_member(b"/opt/b", 2, b"b", b"{\"url\":\"https://x/b.zip\"}",
                                   b"shell", b"tools", 2),
            0,
        );
        let buf = sm_alloc(4096);
        assert_eq!(unsafe { sm_export_image_read(0, buf, 4096) }, -(Errno::EINVAL as i32));
        unsafe { sm_free(buf, 4096) };
    }

    #[test]
    fn export_recomputes_a_seal_rather_than_trusting_one_already_there() {
        // The difference between "seal what is pending" and "re-seal every
        // cohort", which is otherwise invisible: both produce identical bytes
        // for a tree that was only ever registered.
        //
        // It becomes visible when a payload arrives ALREADY sealed and wrong --
        // which is what a derived build sees, because loading a base image
        // brings back its seals. Sealing only what is pending would emit that
        // stale digest and build an image that fails its own verifier.
        fresh_tree();
        assert_eq!(
            register_cohort_member(b"/opt/a", 1, b"a", b"{\"url\":\"https://x/a.zip\"}",
                                   b"shell", b"tools", 1),
            0,
        );
        // Overwrite the declaration with a SEALED payload whose cohort digest
        // is nonsense, the way a stale or hand-edited one would be.
        let descriptor: &[u8] = b"{\"url\":\"https://x/a.zip\"}";
        let stale = seal::encode(&seal::ArchivePayload {
            descriptor: descriptor.to_vec(),
            seal: seal::SealState::Sealed(seal::ArchiveSeal {
                id: b"shell".to_vec(),
                member: b"tools".to_vec(),
                expected_count: 1,
                cohort_digest: [9u8; 32],
                descriptor_digest: seal::sha256(descriptor),
            }),
        })
        .expect("encode");
        rootfs::set_archive_payload(1, &stale).expect("plant the stale seal");

        let image = drain_export();
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert!(
            load_image_bytes(&image) > 0,
            "the export recomputed the cohort instead of carrying the stale digest",
        );
    }

    #[test]
    fn a_cohort_may_be_declared_on_every_member_of_its_archive() {
        // Registration is per file, membership is per archive, so a builder
        // that names the cohort on each member is doing the ordinary thing.
        // Declaring the same membership twice is a no-op, exactly as declaring
        // the same length or the same description twice is.
        fresh_tree();
        assert_eq!(
            register_cohort_member(b"/opt/a", 1, b"a", b"{\"url\":\"https://x/a.zip\"}",
                                   b"shell", b"tools", 1),
            0,
        );
        assert_eq!(
            register_cohort_member(b"/opt/a2", 1, b"a2", b"", b"shell", b"tools", 1),
            0,
            "a second member may repeat its archive's cohort",
        );
    }

    #[test]
    fn one_archive_cannot_belong_to_two_cohorts() {
        // The same rule as two descriptions, for the same reason: the image
        // would otherwise activate according to whichever member happened to be
        // registered last.
        fresh_tree();
        assert_eq!(
            register_cohort_member(b"/opt/a", 1, b"a", b"{\"url\":\"https://x/a.zip\"}",
                                   b"shell", b"tools", 1),
            0,
        );
        assert_eq!(
            register_cohort_member(b"/opt/a2", 1, b"a2", b"", b"desktop", b"tools", 1),
            -(Errno::EINVAL as i32),
        );
    }

    #[test]
    fn an_archive_is_described_once_and_its_other_members_need_not_repeat_it() {
        // GAP 19, and a regression from gap 18's own fix. The description is a
        // property of the ARCHIVE while registration is per FILE, so a builder
        // carries it on one member and omits it on the rest -- the shape the
        // bridge's optional `archiveDescriptor` exists for.
        //
        // Wrapping the caller's bytes broke that. An omitted description used
        // to arrive as an empty payload, which the store reads as "nothing new
        // to say"; wrapped, it became a nine-byte envelope describing nothing,
        // which is a DIFFERENT payload -- and a different payload for one
        // archive is a conflict.
        //
        // The repair is not to special-case empty. It is that merging a
        // description into an archive is a question about the FORMAT, and the
        // format is the module's: the store keeps opaque bytes and has no
        // business deciding when two of them agree.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/opt", b"", |pp, pl, _c, _l| unsafe {
            sm_mkdir(pp, pl, 0o755, 0, 0)
        }), 0);
        let descriptor: &[u8] = b"{\"url\":\"https://example.invalid/tools.zip\"}";
        assert_eq!(register_member(b"/opt/one", 1, b"one", descriptor), 0);
        assert_eq!(
            register_member(b"/opt/two", 1, b"two", b""),
            0,
            "a second member of a described archive need not repeat the description",
        );

        // And the description SURVIVED the member that did not carry it.
        let payloads = rootfs::archive_payloads();
        let (_, stored) = payloads.iter().find(|(id, _)| *id == 1).expect("the archive");
        assert_eq!(seal::decode(stored).expect("decode").descriptor, descriptor);
    }

    #[test]
    fn an_archive_with_no_description_carries_no_payload_at_all() {
        // "Nothing to say" is spelled the same way everywhere else in this
        // format: an empty payload. A `KLZY`-described image carries exactly
        // that, and `decode` accepts it early without reading a version word.
        //
        // Encoding the absence instead -- a version, a zero-length descriptor
        // and a "no seal" byte -- would be nine bytes saying what zero bytes
        // already say, and would put a deferred section into images that have
        // no deferred description to carry.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/opt", b"", |pp, pl, _c, _l| unsafe {
            sm_mkdir(pp, pl, 0o755, 0, 0)
        }), 0);
        assert_eq!(register_member(b"/opt/one", 1, b"one", b""), 0);
        let payloads = rootfs::archive_payloads();
        let (_, stored) = payloads.iter().find(|(id, _)| *id == 1).expect("the archive");
        assert!(stored.is_empty(), "an undescribed archive carries no payload");
    }

    #[test]
    fn one_archive_cannot_be_given_two_descriptions() {
        // The other half of the rule above, and the reason the merge cannot
        // simply take the last value: two members describing one archive
        // differently is a producer bug, and the image it would build fetches
        // from whichever URL happened to be registered last.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/opt", b"", |pp, pl, _c, _l| unsafe {
            sm_mkdir(pp, pl, 0o755, 0, 0)
        }), 0);
        assert_eq!(register_member(b"/opt/one", 1, b"one", b"{\"url\":\"https://a/x.zip\"}"), 0);
        assert_eq!(
            register_member(b"/opt/two", 1, b"two", b"{\"url\":\"https://b/x.zip\"}"),
            -(Errno::EINVAL as i32),
        );
    }

    #[test]
    fn an_image_with_an_ordinary_archive_descriptor_still_loads() {
        // GAP 18. Wiring the verifier made every archive payload a SEAL
        // payload, and the bridge writes a plain JSON descriptor — so decoding
        // read its first four bytes as a version word and refused the load.
        //
        // Each half was tested and the cross-product was not: the load test
        // above uses a payload built by `seal::encode`, the bridge's archive
        // test never reloads, and the shipped corpus carries EMPTY payloads
        // that decode accepts early. This is the case none of them covered.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/opt", b"", |pp, pl, _c, _l| unsafe {
            sm_mkdir(pp, pl, 0o755, 0, 0)
        }), 0);
        let descriptor: &[u8] = b"{\"url\":\"https://example.invalid/tools.zip\"}";
        let (pp, pl) = write_path(b"/opt/tool");
        let (sp, sl) = write_path(b"tool");
        let dp = sm_alloc(descriptor.len());
        unsafe {
            core::ptr::copy_nonoverlapping(descriptor.as_ptr(), dp as *mut u8, descriptor.len())
        };
        assert_eq!(
            unsafe {
                sm_register_lazy_file(
                    pp, pl, 1, sp, sl, 99, 0o644, 0, 0, 4_000_000, 4096, dp, descriptor.len(),
                     0, 0, 0, 0, 0,
                )
            },
            0,
        );
        unsafe { sm_free(pp, pl) };
        unsafe { sm_free(sp, sl) };
        unsafe { sm_free(dp, descriptor.len()) };
        let image = drain_export();

        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert!(
            load_image_bytes(&image) > 0,
            "an archive carrying an ordinary descriptor must still load",
        );
    }

    #[test]
    fn a_load_refuses_an_image_whose_seals_do_not_authenticate() {
        // The wiring, not the verifier. `seal::verify_cohorts` has its own ten
        // trials; this asserts that `sm_load_image` CALLS it — which it did not
        // for several commits while the verifier sat complete and inert.
        //
        // The archive declares a cohort of two and supplies one, which is the
        // partial activation atomic cohorts exist to prevent.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let descriptor: &[u8] = b"{\"url\":\"https://example.invalid/tools.zip\"}";
        let mut identity = alloc::vec![
            (b"tools".to_vec(), seal::sha256(descriptor)),
            (b"docs".to_vec(), seal::sha256(b"{}")),
        ];
        let cohort = seal::sha256(
            &seal::cohort_identity(b"shell", &mut identity).expect("identity"),
        );
        let payload = seal::encode(&seal::ArchivePayload {
            descriptor: descriptor.to_vec(),
            seal: seal::SealState::Sealed(seal::ArchiveSeal {
                id: b"shell".to_vec(),
                member: b"tools".to_vec(),
                expected_count: 2,
                cohort_digest: cohort,
                descriptor_digest: seal::sha256(descriptor),
            }),
        })
        .expect("encode");

        // Build an image carrying that single sealed archive.
        //
        // Registration cannot be handed a seal — it wraps the caller's
        // DESCRIPTOR and writes `SealState::None`, which is what makes every
        // payload well formed. Sealing is the module's own act, and until the
        // producer half performs it at export, the only honest way to stand up
        // a sealed archive is to write the payload where the producer will:
        // straight into the stored archive.
        assert_eq!(with_two(b"/opt", b"", |pp, pl, _c, _l| unsafe {
            sm_mkdir(pp, pl, 0o755, 0, 0)
        }), 0);
        let (pp, pl) = write_path(b"/opt/tool");
        let (sp, sl) = write_path(b"tool");
        let dp = sm_alloc(descriptor.len());
        unsafe {
            core::ptr::copy_nonoverlapping(descriptor.as_ptr(), dp as *mut u8, descriptor.len())
        };
        assert_eq!(
            unsafe {
                sm_register_lazy_file(
                    pp, pl, 1, sp, sl, 99, 0o644, 0, 0, 4_000_000, 4096, dp, descriptor.len(),
                     0, 0, 0, 0, 0,
                )
            },
            0,
        );
        unsafe { sm_free(pp, pl) };
        unsafe { sm_free(sp, sl) };
        unsafe { sm_free(dp, descriptor.len()) };
        rootfs::set_archive_payload(1, &payload).expect("seal the registered archive");

        // Emitted WITHOUT going through `sm_export_image_read`, and that is
        // the point rather than a shortcut. The producer now re-seals at the
        // export door, so it would refuse this cohort before writing a byte --
        // an image whose seals do not authenticate is, by construction, one no
        // honest producer emits. Reaching past the door is the only way to
        // stand up the artifact a tampered image actually is, and what is
        // under test here is the LOAD.
        let image = {
            let mut image: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
            let mut chunk = alloc::vec![0u8; 64 * 1024];
            let mut source = image_source;
            let mut offset = 0i64;
            loop {
                let n = rootfs::export_container_read(offset, &mut chunk, &mut source)
                    .expect("emit the tampered container");
                if n == 0 {
                    break;
                }
                image.extend_from_slice(&chunk[..n]);
                offset += n as i64;
                assert!(image.len() <= 4 * 1024 * 1024, "the export is not advancing");
            }
            image
        };

        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let rc = load_image_bytes(&image);
        assert_eq!(rc, -(Errno::EPERM as i32), "a cohort short of its count");

        // And the refusal UNLOADS: an image that failed to authenticate must
        // not be left mounted for the next call to build on.
        assert!(image_bytes().is_none(), "the refused image was released");
        let (qp, ql) = write_path(b"/opt/tool");
        let buf = sm_alloc(64);
        assert!(unsafe { sm_lstat(qp, ql, buf, 64) } < 0, "and its tree is gone");
        unsafe { sm_free(qp, ql) };
        unsafe { sm_free(buf, 64) };
    }

    #[test]
    fn a_small_request_cannot_cost_a_tree_the_inodes_it_needs() {
        // The convergence loop already re-raises the ceiling to whatever the
        // DATA needs, so a tiny tree cannot tell a floor from a replacement.
        // The inode requirement is the half that loop does not recompute: a
        // hundred empty files need `(n + 2) * 4` blocks for their inodes and
        // almost no blocks for their bytes. A request that REPLACED the
        // requirement instead of flooring it would size this image by its
        // bytes and leave it without room for its own inodes.
        //
        // In practice the writer refuses before that: the export returns
        // ENOSPC partway through creating the hundredth file, and
        // `drain_export` fails on the negative count. The ceiling assertion
        // below is still the contract being stated — an image sized to hold
        // its own inodes — and it is what would catch a future writer that
        // grew quieter about running out.
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        const FILES: u64 = 100;
        for i in 0..FILES {
            let mut path = alloc::vec::Vec::from(&b"/f"[..]);
            let mut n = i;
            loop {
                path.push(b'0' + (n % 10) as u8);
                n /= 10;
                if n == 0 {
                    break;
                }
            }
            let (pp, pl) = write_path(&path);
            assert_eq!(unsafe { sm_write_file(pp, pl, 0o644, 0, 0) }, 0);
            unsafe { sm_free(pp, pl) };
        }

        // One byte: as small a request as can be made without clearing it.
        assert_eq!(unsafe { sm_set_image_options(1, 0, 0) }, 0);
        let image = drain_export();
        let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount");
        let ceiling = fs.growth_ceiling_bytes().expect("ceiling");

        // `total_inodes = max_blocks / 4` is the writer's rule, so the ceiling
        // is where the inode count is observable from the artifact.
        let inodes = ceiling / 4096 / 4;
        assert!(
            inodes >= FILES + 2,
            "{FILES} files plus root and its spare need {} inodes; the image              allows {inodes}",
            FILES + 2,
        );
    }

    #[test]
    fn headroom_is_judged_with_the_numbers_behind_the_verdict() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_two(b"/f", b"hello", |pp, pl, cp, cl| unsafe {
            sm_write_file(pp, pl, 0o644, cp, cl)
        }), 0);

        let size = unsafe { sm_check_headroom(0, 0, 0, 0) };
        assert_eq!(size, 40, "five u64s, discoverable without a second export");
        let buf = sm_alloc(40);
        let read = |min_bytes: u64, min_inodes: u64| -> (i32, [u64; 5]) {
            let rc = unsafe { sm_check_headroom(min_bytes, min_inodes, buf, 40) };
            let bytes = unsafe { core::slice::from_raw_parts(buf as *const u8, 40) };
            let mut out = [0u64; 5];
            for (i, slot) in out.iter_mut().enumerate() {
                *slot = u64::from_le_bytes(bytes[i * 8..i * 8 + 8].try_into().expect("8"));
            }
            (rc, out)
        };

        // A profile this image meets.
        let (rc, [free_bytes, required_bytes, free_inodes, required_inodes, capacity]) = read(0, 0);
        assert_eq!(rc, 0, "zero required is met by anything");
        assert_eq!(required_bytes, 0);
        assert_eq!(required_inodes, 0);
        assert!(free_bytes > 0, "a fresh image has free space");
        assert!(free_inodes > 0, "and free inodes");
        assert!(capacity > 0, "and the ceiling it will declare");

        // A profile it cannot meet. The numbers come back either way, which is
        // the point: a caller that only learns "no" cannot say by how much.
        let (rc, [reported_free, required, _, _, _]) = read(u64::MAX, 0);
        assert!(rc < 0, "an unmeetable profile is a failure, got {rc}");
        assert_eq!(required, u64::MAX, "and it reports what was required");
        assert_eq!(
            reported_free, free_bytes,
            "and the same free count as the passing call -- the verdict changed, \
             not the measurement",
        );

        let (rc, [_, _, _, required_inodes, _]) = read(0, u64::MAX);
        assert!(rc < 0, "free inodes are checked too, not only bytes");
        assert_eq!(required_inodes, u64::MAX);

        // The REPORTED free count must be the real measurement, not merely a
        // number that travels beside a correct verdict. Mutation found this
        // gap: the verdict comes from the policy's own statfs, so a wrong
        // `free_bytes` changed no outcome and every assertion above still
        // passed. A build script PRINTS this number, and a confident wrong
        // number is worse than none.
        //
        // Two independent checks, because either alone is weak. It cannot
        // exceed what the image could ever hold, and it must FALL when the
        // tree grows.
        let (_, [free_bytes, _, _, _, capacity]) = read(0, 0);
        assert!(
            free_bytes <= capacity,
            "free {free_bytes} exceeds the image's own ceiling {capacity}",
        );

        // Tie the reported number to the ARTIFACT rather than to itself. The
        // verdict comes from its own comparison, so a wrong `free_bytes` would
        // travel beside a correct answer and change no outcome — which is
        // exactly what a mutation replacing this measurement with `u64::MAX`
        // demonstrated. A build script PRINTS this, and a confident wrong
        // number is worse than none.
        let image = drain_export();
        let body = runtime_core::sffs::unwrap_vfsi(&image).expect("a container");
        let fs = runtime_core::sffs::Sffs::mount(body).expect("mount");
        let st = fs.statfs().expect("statfs");
        let occupied = (st.f_blocks - st.f_bfree) * u64::from(st.f_frsize);
        assert_eq!(
            free_bytes,
            fs.growth_ceiling_bytes().expect("ceiling") - occupied,
            "the reported headroom is the exported image's own ceiling minus \
             what it occupies",
        );

        // With no requested capacity the export sizes to its tree, so this is
        // the fixed slack — which is what made the check meaningless before a
        // capacity could be asked for (gap 14). SIXTY-THREE blocks, not
        // sixty-four: one block of that slack now holds the deferred section
        // every image carries so the kernel can load it back (gap 15).
        assert_eq!(free_bytes, 63 * 4096, "the fixed slack, with nothing requested");

        // Ask for a capacity and the headroom becomes a real measurement: it
        // reflects the room the product declared, and it FALLS as the tree
        // grows into it. That is the property the assertion exists for, and it
        // was unreachable while the ceiling was derived from the tree.
        assert_eq!(unsafe { sm_set_image_options(64 * 1024 * 1024, 0, 0) }, 0);
        let (_, [roomy, _, _, _, _]) = read(0, 0);
        assert!(
            roomy > 60 * 1024 * 1024,
            "a 64 MiB request leaves real headroom, got {roomy}",
        );
        let filler = alloc::vec![b'x'; 4 * 1024 * 1024];
        assert_eq!(
            with_two(b"/filler", &filler, |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o644, cp, cl)
            }),
            0
        );
        let (_, [after, _, _, _, _]) = read(0, 0);
        assert!(
            after < roomy,
            "writing 4 MiB into the declared room consumes it: {roomy} -> {after}",
        );
        assert_eq!(unsafe { sm_set_image_options(0, 0, 0) }, 0);

        unsafe { sm_free(buf, 32) };
    }

    #[test]
    fn the_stat_record_says_whether_a_files_bytes_are_present() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/usr", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        assert_eq!(
            with_two(b"/usr/here", b"bytes", |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o644, cp, cl)
            }),
            0
        );
        let rc = with_two(b"/usr/there", b"members/big.bin", |pp, pl, sp, sl| unsafe {
            sm_register_lazy_file(pp, pl, 3, sp, sl, 99_999, 0o755, 0, 0, 40, 8_000_000, 0, 0, 0, 0, 0, 0, 0)
        });
        assert_eq!(rc, 0);

        let size = unsafe { sm_lstat(0, 0, 0, 0) } as usize;
        assert_eq!(size, 64, "eight u64s, and the bridge asks rather than assumes");
        let read = |path: &[u8]| -> alloc::vec::Vec<u64> {
            let buf = sm_alloc(size);
            assert_eq!(with_path(path, |p, l| unsafe { sm_lstat(p, l, buf, size) }), 0);
            let bytes = unsafe { core::slice::from_raw_parts(buf as *const u8, size) };
            let out: alloc::vec::Vec<u64> = (0..8)
                .map(|i| {
                    u64::from_le_bytes(bytes[i * 8..i * 8 + 8].try_into().expect("8 bytes"))
                })
                .collect();
            unsafe { sm_free(buf, size) };
            out
        };

        let here = read(b"/usr/here");
        assert_eq!(here[6], 0, "written through the ABI, so its bytes are here");
        assert_eq!(here[5], 5);
        assert_eq!(here[7], 0, "and no archive behind it");

        let there = read(b"/usr/there");
        assert_eq!(there[6], 1, "registered lazy, so its bytes are not");
        assert_eq!(there[0], 40, "the inode it was registered under");
        assert_eq!(
            there[5], 99_999,
            "the REAL size, not the zero-length stub -- a recipe asking how big \
             a deferred file is must not have to fetch it first",
        );
        assert_eq!(there[7], 3, "and which archive backs it");
    }

    #[test]
    fn failures_come_back_as_negative_errno() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        let rc = with_path(b"/absent/deep", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) });
        assert!(rc < 0, "a missing parent must fail, got {rc}");
        let rc = with_path(b"/nothing-here", |p, l| unsafe { sm_unlink(p, l) });
        assert!(rc < 0, "unlinking an absent path must fail, got {rc}");
    }

    /// The release half of release-before-create: a second build after
    /// `sm_reset` must not inherit anything from the first.
    #[test]
    fn reset_gives_the_next_image_a_clean_slate() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/a", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        let first = rootfs::lstat(b"/a").expect("a").st_ino;

        assert_eq!(sm_reset(0o755, 0, 0), 0);
        assert!(rootfs::lstat(b"/a").is_err(), "the previous tree must be gone");
        assert_eq!(with_path(b"/a", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        assert_eq!(
            rootfs::lstat(b"/a").expect("a").st_ino,
            first,
            "the second build must allocate the same inode numbers as the first",
        );
    }

    #[test]
    fn a_zero_length_allocation_is_not_a_null_pointer_case() {
        // The builders write empty files; the ABI must not confuse "empty" with
        // "failed". The ASSERTION is the test -- an earlier version called
        // sm_alloc(0) and freed it without checking the pointer, so a version
        // returning null passed it. Mutation testing caught that.
        let ptr = sm_alloc(0);
        assert_ne!(ptr, 0, "an empty buffer is a valid buffer, not a failure");
        unsafe { sm_free(ptr, 0) };
    }

    /// chown must clear the set-user-ID bit when asked, and that flag is not
    /// bookkeeping: it is what stops a builder that re-owns a setuid binary
    /// from leaving it setuid to the new owner. Lane S exists because
    /// setuid-root binaries in these images are security-relevant.
    ///
    /// Added after a mutant that made sm_chown ignore clear_setid survived the
    /// whole suite.
    #[test]
    fn chown_clears_setuid_when_asked_and_leaves_it_otherwise() {
        assert_eq!(sm_reset(0o755, 0, 0), 0);

        // Not cleared unless requested.
        assert_eq!(with_path(b"/keep", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        assert_eq!(with_path(b"/keep", |p, l| unsafe { sm_chmod(p, l, 0o4755) }), 0);
        assert_eq!(with_path(b"/keep", |p, l| unsafe { sm_chown(p, l, 1, 1, 0) }), 0);
        assert_eq!(
            rootfs::lstat(b"/keep").expect("keep").st_mode & 0o7777,
            0o4755,
            "clear_setid = 0 must leave the set-user-ID bit alone",
        );

        // Cleared when requested.
        assert_eq!(with_path(b"/drop", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        assert_eq!(with_path(b"/drop", |p, l| unsafe { sm_chmod(p, l, 0o4755) }), 0);
        assert_eq!(with_path(b"/drop", |p, l| unsafe { sm_chown(p, l, 1, 1, 1) }), 0);
        assert_eq!(
            rootfs::lstat(b"/drop").expect("drop").st_mode & 0o7777,
            0o0755,
            "clear_setid = 1 must drop the set-user-ID bit",
        );
    }
}
