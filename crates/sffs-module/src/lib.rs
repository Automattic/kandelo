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
