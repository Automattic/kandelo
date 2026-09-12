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
pub extern "C" fn sm_reset() {
    rootfs::reset();
}

/// Create the root inode. Every other path operation needs it to exist.
#[unsafe(no_mangle)]
pub extern "C" fn sm_init_root(mode: u32, uid: u32, gid: u32) -> i32 {
    ok_or_errno(rootfs::insert_base_dir(b"/", mode, uid, gid, 1))
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

/// Size in bytes of the record [`sm_lstat`] writes: six little-endian `u64`s.
///
/// Queried rather than hardcoded, so a caller never bakes in a number this
/// module could change.
#[unsafe(no_mangle)]
pub extern "C" fn sm_stat_size() -> usize {
    6 * 8
}

/// Field order of the [`sm_lstat`] record. Six `u64`s, little-endian:
///
/// | offset | field |
/// |---|---|
/// | 0  | ino |
/// | 8  | mode |
/// | 16 | nlink |
/// | 24 | uid |
/// | 32 | gid |
/// | 40 | size |
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
    let path = unsafe { slice(path_ptr, path_len) };
    let stat = match rootfs::lstat(path) {
        Ok(stat) => stat,
        Err(e) => return err(e),
    };
    if out_ptr == 0 || out_len < sm_stat_size() {
        return err(Errno::EINVAL);
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr as *mut u8, out_len) };
    let fields: [u64; 6] = [
        stat.st_ino,
        stat.st_mode as u64,
        stat.st_nlink as u64,
        stat.st_uid as u64,
        stat.st_gid as u64,
        stat.st_size,
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
    // The byte source is EIO for the same reason as in `sm_write_file`: this
    // module has no host blob store, so a BASE file's bytes are unreachable
    // here. Unlike the write path, this one CAN reach it -- reading a base
    // file is exactly the case -- so the failure is real and loud rather than
    // unreachable. A derived build must wire a real source.
    match rootfs::read_file_at(path, offset, out, |_req, _dst| Err(Errno::EIO)) {
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
    // Base content is unreachable here for the same reason as elsewhere in this
    // module: no host blob store. A fresh build has no base files, so this is
    // not consulted; a derived build must supply a real source before it can
    // export base-backed content.
    let mut source = |_req: rootfs::ByteReq, _dst: &mut [u8]| Err(Errno::EIO);
    match rootfs::export_image_read(offset, out, &mut source) {
        Ok(n) => n as i32,
        Err(e) => err(e),
    }
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
) -> i32 {
    // The archive's length is declared HERE rather than through an entry point
    // of its own. A member is useless without it -- fetching one member means
    // fetching the archive, and that read has to be bounded -- so taking it
    // alongside the member makes it impossible to register a member whose
    // archive has no length, without costing the host another export to
    // implement. Re-declaring the same length is a no-op; a different one is
    // EINVAL, because one archive with two lengths has no correct reading.
    if let Err(e) = rootfs::declare_archive(archive_id, archive_bytes) {
        return err(e);
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
    ))
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        assert_eq!(
            with_two(b"/f", b"12345", |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o640, cp, cl)
            }),
            0
        );
        assert_eq!(with_path(b"/f", |p, l| unsafe { sm_chown(p, l, 3, 4, 0) }), 0);

        let size = sm_stat_size();
        assert_eq!(size, 48, "six u64 fields");
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
        unsafe { sm_free(out, size) };
    }

    /// A buffer too small for the record is refused rather than partially
    /// filled: a half-written stat is worse than no stat, because it looks
    /// like data.
    #[test]
    fn lstat_refuses_an_undersized_buffer() {
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        let size = sm_stat_size();
        let out = sm_alloc(size);
        let rc = with_path(b"/", |p, l| unsafe { sm_lstat(p, l, out, size - 1) });
        assert!(rc < 0, "an undersized buffer must fail, got {rc}");
        unsafe { sm_free(out, size) };
    }

    #[test]
    fn readlink_and_read_file_return_byte_counts() {
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        unsafe { sm_free(buf, 32) };
    }

    /// Reading a BASE file is the case the write path could not reach: its
    /// bytes live in a host blob this module has no access to, so the failure
    /// is real rather than unreachable, and must be loud.
    #[test]
    fn reading_a_base_file_fails_loudly_rather_than_returning_zeroes() {
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/empty", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        let required = with_path(b"/empty", |p, l| unsafe { sm_read_dir(p, l, 0, 0) });
        assert_eq!(required, 0, "an empty directory needs no bytes, and is not a failure");
    }

    #[test]
    fn read_dir_on_a_missing_path_is_an_error() {
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        let rc = with_path(b"/nope", |p, l| unsafe { sm_read_dir(p, l, 0, 0) });
        assert!(rc < 0, "a missing directory must be an error, not an empty listing, got {rc}");
    }

    /// What does the export actually emit -- the raw SFFS body, or the whole
    /// VFSI container? Measured rather than assumed, because the answer decides
    /// whether the bridge must wrap the bytes before writing a .vfs file.
    #[test]
    fn the_export_emits_a_mountable_sffs_body() {
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/usr", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        assert_eq!(
            with_two(b"/usr/hello", b"hi", |pp, pl, cp, cl| unsafe {
                sm_write_file(pp, pl, 0o644, cp, cl)
            }),
            0
        );

        let chunk = 64 * 1024;
        let buf = sm_alloc(chunk);
        let mut image: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let mut offset = 0i64;
        loop {
            let n = unsafe { sm_export_image_read(offset, buf, chunk) };
            assert!(n >= 0, "export failed at offset {offset}: {n}");
            if n == 0 {
                break;
            }
            let got = unsafe { core::slice::from_raw_parts(buf as *const u8, n as usize) };
            image.extend_from_slice(got);
            offset += n as i64;
        }
        unsafe { sm_free(buf, chunk) };
        assert!(!image.is_empty(), "the export must produce bytes");

        // The decisive check: mount what came out. If this is a container the
        // mount fails, and the bridge would need to unwrap first.
        let fs = runtime_core::sffs::Sffs::mount(image.clone())
            .expect("the export emits a mountable SFFS body, not a wrapped container");

        // And the tree that comes back is the tree that was built.
        let ino = fs.resolve(b"/usr/hello", true).expect("resolve /usr/hello");
        let st = fs.stat_ino(ino).expect("stat");
        assert_eq!(st.mode & 0o7777, 0o644);
        assert_eq!(st.size, 2);
        let mut back = [0u8; 2];
        fs.read_at(ino, 0, &mut back).expect("read");
        assert_eq!(&back, b"hi", "the exported image carries the content written through the ABI");
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        rootfs::insert_base_file(b"/base.bin", 42, 4096, 0o644, 0, 0, 9).expect("insert base");

        let chunk = 64 * 1024;
        let buf = sm_alloc(chunk);
        let mut image: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let mut offset = 0i64;
        loop {
            let n = unsafe { sm_export_image_read(offset, buf, chunk) };
            assert!(n >= 0, "the export completes; it does not consult the base bytes. got {n}");
            if n == 0 {
                break;
            }
            let got = unsafe { core::slice::from_raw_parts(buf as *const u8, n as usize) };
            image.extend_from_slice(got);
            offset += n as i64;
        }
        unsafe { sm_free(buf, chunk) };

        let fs = runtime_core::sffs::Sffs::mount(image).expect("mount the exported image");
        let ino = fs.resolve(b"/base.bin", false).expect("the path survives");
        let st = fs.stat_ino(ino).expect("stat");

        assert_eq!(st.size, 0, "THE DAMAGE: a 4096-byte file exports as zero-length");
        assert!(
            fs.deferred_section().expect("decodes").is_none(),
            "THE DAMAGE: and with no deferred record, so nothing records where its bytes were",
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/usr", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);

        let rc = with_two(b"/usr/big", b"members/big.bin", |pp, pl, sp, sl| unsafe {
            sm_register_lazy_file(pp, pl, 3, sp, sl, 99_999, 0o755, 0, 0, 40, 8_000_000)
        });
        assert_eq!(rc, 0);

        // Registration is correct: the metadata is right before any fetch.
        let st = rootfs::lstat(b"/usr/big").expect("lazy file exists");
        assert_eq!(st.st_size, 99_999, "the manifest size is authoritative pre-fetch");
        assert_eq!(st.st_mode & 0o7777, 0o755);

        let chunk = 64 * 1024;
        let buf = sm_alloc(chunk);
        let mut image: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let mut offset = 0i64;
        loop {
            let n = unsafe { sm_export_image_read(offset, buf, chunk) };
            assert!(n >= 0, "the export completes, which is the problem. got {n}");
            if n == 0 {
                break;
            }
            let got = unsafe { core::slice::from_raw_parts(buf as *const u8, n as usize) };
            image.extend_from_slice(got);
            offset += n as i64;
        }
        unsafe { sm_free(buf, chunk) };

        let fs = runtime_core::sffs::Sffs::mount(image).expect("mount");
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
    fn failures_come_back_as_negative_errno() {
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        let rc = with_path(b"/absent/deep", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) });
        assert!(rc < 0, "a missing parent must fail, got {rc}");
        let rc = with_path(b"/nothing-here", |p, l| unsafe { sm_unlink(p, l) });
        assert!(rc < 0, "unlinking an absent path must fail, got {rc}");
    }

    /// The release half of release-before-create: a second build after
    /// `sm_reset` must not inherit anything from the first.
    #[test]
    fn reset_gives_the_next_image_a_clean_slate() {
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
        assert_eq!(with_path(b"/a", |p, l| unsafe { sm_mkdir(p, l, 0o755, 0, 0) }), 0);
        let first = rootfs::lstat(b"/a").expect("a").st_ino;

        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);
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
        sm_reset();
        assert_eq!(sm_init_root(0o755, 0, 0), 0);

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
