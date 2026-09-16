//! Sound access to guest linear memory.
//!
//! # The defect this exists for
//!
//! Every reader in this crate takes a whole-memory `&[u8]` and indexes it with
//! ABSOLUTE guest offsets. The callers build that slice the only way wasm's flat
//! address space allows:
//!
//! ```ignore
//! core::slice::from_raw_parts(core::hint::black_box(0usize) as *const u8, len)
//! ```
//!
//! `from_raw_parts` requires a NON-NULL base. Guest offset 0 is a perfectly
//! valid wasm address, but the Rust abstract machine does not agree, and
//! `black_box` hides the zero from the lint without making the pointer valid.
//! The resulting slice is ill-formed, and the compiler is entitled to act on
//! what it was promised. Measured from inside the module on a 16 MiB memory
//! (census section 140):
//!
//! ```text
//! mem_ref().len()           = 16777216
//! mem_ref().get(0..32)      = None
//! ```
//!
//! A `get` that refuses a 32-byte range at offset zero on a 16 MiB slice is not
//! something safe Rust can do. The bounds check had been folded to always-fail.
//! It does not fold everywhere — the same shape works in other contexts, which
//! is worse than if it failed consistently, because the surviving callers are
//! not correct, only not yet miscompiled.
//!
//! # Why a type rather than a fix at the construction site
//!
//! There is no sound way to express "a slice covering all of linear memory,
//! based at 0". The address really is zero and Rust really does forbid it. So
//! the whole-memory slice has to stop existing, and every read has to name the
//! range it wants — which is non-null for any real datum, because nothing this
//! crate decodes lives at guest offset 0.
//!
//! That is the one invariant worth stating plainly: **offset 0 is refused.**
//! Not because reading it would be unsound, but because a 0 here has always
//! meant an uninitialised pointer, a missing root, or a decode that ran off the
//! front of a record — and every one of those is a bug that should stop rather
//! than read plausible bytes out of the null page.

use wasm_posix_shared::Errno;

/// A handle to the guest's linear memory, which hands out per-access slices.
///
/// Holds a length, not a slice: constructing the slice is what has to be
/// deferred to the access, so that each one is based at a real offset.
#[derive(Debug, Clone, Copy)]
pub struct GuestMemory {
    len: usize,
}

impl GuestMemory {
    /// Wrap a guest memory of `len` bytes.
    ///
    /// # Safety
    /// `len` must be the live byte length of the guest's linear memory, and the
    /// whole range `[0, len)` must be addressable for the life of this value.
    /// Growing the memory invalidates it; take a fresh one after any growth.
    pub unsafe fn new(len: usize) -> Self {
        GuestMemory { len }
    }

    /// The memory's byte length.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether the memory is empty, which for a live guest means never.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Read `len` bytes at absolute guest offset `at`.
    ///
    /// Refuses offset 0, a zero length, and any range that leaves the memory.
    /// See the module docs for why 0 is refused rather than read.
    pub fn read(&self, at: usize, len: usize) -> Result<&[u8], Errno> {
        self.check(at, len)?;
        // SAFETY: `at` is non-zero and `[at, at + len)` is inside the guest's
        // linear memory, both checked above. `black_box` keeps the base opaque
        // so the address is not a statically visible constant, matching the
        // idiom the rest of the runtime uses for guest-offset-as-pointer.
        Ok(unsafe { core::slice::from_raw_parts(core::hint::black_box(at) as *const u8, len) })
    }

    /// Write-through view of `len` bytes at absolute guest offset `at`.
    ///
    /// Same refusals as [`read`](GuestMemory::read).
    ///
    /// # Safety
    /// The caller must not hold two overlapping mutable views at once; this
    /// type cannot see the other one.
    pub unsafe fn write(&self, at: usize, len: usize) -> Result<&mut [u8], Errno> {
        self.check(at, len)?;
        // SAFETY: as `read`, plus the caller's non-overlap obligation above.
        Ok(unsafe {
            core::slice::from_raw_parts_mut(core::hint::black_box(at) as *mut u8, len)
        })
    }

    fn check(&self, at: usize, len: usize) -> Result<(), Errno> {
        if at == 0 || len == 0 {
            return Err(Errno::EINVAL);
        }
        let end = at.checked_add(len).ok_or(Errno::EINVAL)?;
        if end > self.len {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }
}
