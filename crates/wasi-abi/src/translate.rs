//! The pure WASI <-> POSIX translation functions.
//!
//! These are the eight module-private functions of `host/src/wasi-shim.ts`
//! plus the four the defect fixes add. All of them are `const fn` over
//! integers, so `cargo test -p wasi-abi` exercises every one of them on the
//! host target with no wasm involved.
//!
//! Where behavior deliberately differs from the TypeScript, the divergence is
//! marked **DEFECT FIX** and named, so the differential harness can carry an
//! explicit documented exception instead of certifying the old behavior.

use wasm_posix_shared::{fcntl_cmd, flags, mode, seek};

use crate::errno::WasiErrno;
use crate::types::{
    WasiClock, WasiEventType, WasiFdflags, WasiFiletype, WasiLookupflags, WasiOflags, WasiWhence,
};

/// POSIX `CLOCK_*` ids. `wasm_posix_shared` does not export these, and they
/// are part of the kernel's `clock_gettime` contract rather than of WASI.
pub mod posix_clock {
    pub const CLOCK_REALTIME: u32 = 0;
    pub const CLOCK_MONOTONIC: u32 = 1;
    pub const CLOCK_PROCESS_CPUTIME_ID: u32 = 2;
    pub const CLOCK_THREAD_CPUTIME_ID: u32 = 3;
}

/// POSIX `poll` event bits, as the kernel's `poll` expects them.
///
/// Taken from `wasm_posix_shared::poll` rather than redeclared; they are `u16`
/// here because the WASI side treats them as an opaque bit set, while the
/// kernel's `WasmPollFd` field is `i16`.
pub mod poll_events {
    use wasm_posix_shared::poll;

    pub const POLLIN: u16 = poll::POLLIN as u16;
    pub const POLLOUT: u16 = poll::POLLOUT as u16;
    pub const POLLERR: u16 = poll::POLLERR as u16;
    pub const POLLHUP: u16 = poll::POLLHUP as u16;
}

/// Map a POSIX `st_mode` onto a WASI `filetype`.
///
/// Mirrors `modeToFiletype` (`host/src/wasi-shim.ts:375`). A FIFO is reported
/// as a character device because WASI Preview 1 has no FIFO filetype; that is
/// the closest available value and matches the TypeScript.
pub const fn mode_to_filetype(st_mode: u32) -> WasiFiletype {
    match st_mode & mode::S_IFMT {
        mode::S_IFBLK => WasiFiletype::BlockDevice,
        mode::S_IFCHR => WasiFiletype::CharacterDevice,
        mode::S_IFDIR => WasiFiletype::Directory,
        mode::S_IFREG => WasiFiletype::RegularFile,
        mode::S_IFLNK => WasiFiletype::SymbolicLink,
        mode::S_IFSOCK => WasiFiletype::SocketStream,
        mode::S_IFIFO => WasiFiletype::CharacterDevice,
        _ => WasiFiletype::Unknown,
    }
}

/// Map a WASI `whence` onto a POSIX `SEEK_*`.
///
/// Returns `None` for an undefined whence, which the caller must turn into
/// `WasiErrno::Inval` *before* issuing any syscall -- the TypeScript does the
/// same (`wasi-shim.ts:388`) and `host/test/wasi-shim.test.ts:239` asserts it.
pub const fn wasi_whence_to_posix(whence: u32) -> Option<u32> {
    match WasiWhence::from_u32(whence) {
        Some(WasiWhence::Set) => Some(seek::SEEK_SET),
        Some(WasiWhence::Cur) => Some(seek::SEEK_CUR),
        Some(WasiWhence::End) => Some(seek::SEEK_END),
        None => None,
    }
}

/// Map a WASI `clockid` onto a POSIX `CLOCK_*`.
///
/// Returns `None` for an undefined clock. **This is stricter than the
/// TypeScript**, which silently defaults an unknown clock to `CLOCK_REALTIME`
/// (`wasi-shim.ts:398`). That silent default is a sixth latent defect beyond
/// the five the migration was chartered to fix, so this function reports the
/// truth and the *caller* decides; see `wasi_clock_to_posix_lenient` for the
/// bug-compatible behavior the entry points currently keep.
pub const fn wasi_clock_to_posix(clock: u32) -> Option<u32> {
    match WasiClock::from_u32(clock) {
        Some(WasiClock::Realtime) => Some(posix_clock::CLOCK_REALTIME),
        Some(WasiClock::Monotonic) => Some(posix_clock::CLOCK_MONOTONIC),
        Some(WasiClock::ProcessCputime) => Some(posix_clock::CLOCK_PROCESS_CPUTIME_ID),
        Some(WasiClock::ThreadCputime) => Some(posix_clock::CLOCK_THREAD_CPUTIME_ID),
        None => None,
    }
}

/// Bug-compatible companion to [`wasi_clock_to_posix`]: an undefined clock
/// becomes `CLOCK_REALTIME`, exactly as `wasiClockToPosix` does today.
///
/// Kept separate and named so the behavior is a deliberate, greppable choice
/// rather than an accident of a `match` arm, and so the differential harness
/// can assert *both* -- that Rust agrees with the TypeScript here, and that
/// the strict function disagrees precisely on the undefined inputs.
pub const fn wasi_clock_to_posix_lenient(clock: u32) -> u32 {
    match wasi_clock_to_posix(clock) {
        Some(posix) => posix,
        None => posix_clock::CLOCK_REALTIME,
    }
}

/// Map WASI `oflags` + `fdflags` onto the POSIX `open` flags for `openat`.
///
/// Mirrors `wasiOflagsToPosix` (`host/src/wasi-shim.ts:408`). Access mode is
/// deliberately absent: `path_open` decides it separately from the requested
/// rights, exactly as the TypeScript does.
pub const fn wasi_oflags_to_posix(oflags: WasiOflags, fdflags: WasiFdflags) -> u32 {
    let mut out = 0u32;
    if oflags.contains(WasiOflags::CREAT) {
        out |= flags::O_CREAT;
    }
    if oflags.contains(WasiOflags::DIRECTORY) {
        out |= flags::O_DIRECTORY;
    }
    if oflags.contains(WasiOflags::EXCL) {
        out |= flags::O_EXCL;
    }
    if oflags.contains(WasiOflags::TRUNC) {
        out |= flags::O_TRUNC;
    }
    if fdflags.contains(WasiFdflags::APPEND) {
        out |= flags::O_APPEND;
    }
    if fdflags.contains(WasiFdflags::NONBLOCK) {
        out |= flags::O_NONBLOCK;
    }
    out
}

/// Map POSIX open flags (as returned by `fcntl(F_GETFL)`) onto WASI `fdflags`.
///
/// Mirrors `posixFlagToWasiFdflags` (`host/src/wasi-shim.ts:419`). Only the
/// two bits Kandelo actually tracks are reported; the synchronised-write bits
/// have no POSIX counterpart in this kernel, so claiming them would be a lie.
pub const fn posix_flags_to_wasi_fdflags(posix_flags: u32) -> WasiFdflags {
    let mut out = 0u32;
    if posix_flags & flags::O_APPEND != 0 {
        out |= WasiFdflags::APPEND.bits();
    }
    if posix_flags & flags::O_NONBLOCK != 0 {
        out |= WasiFdflags::NONBLOCK.bits();
    }
    WasiFdflags(out)
}

/// **DEFECT FIX 3** -- `fd_fdstat_set_flags` silently succeeding for
/// `O_SYNC` / `O_DSYNC` / `O_RSYNC`.
///
/// `fdFdstatSetFlags` (`host/src/wasi-shim.ts:941`) maps only `APPEND` and
/// `NONBLOCK` and then returns success, so a guest asking for synchronised
/// writes is told it got them and does not. `wasm_posix_shared::flags` defines
/// no `O_SYNC`, `O_DSYNC`, or `O_RSYNC`, so the kernel genuinely cannot honor
/// the request -- the correct answer is the honest failure the
/// debugging-and-POSIX contract requires.
///
/// Returns the POSIX flags to pass to `fcntl(F_SETFL)`, or `NotSup` if any
/// synchronised-write bit is set. An undefined bit is `Inval`.
pub const fn wasi_fdflags_to_setfl(fdflags: WasiFdflags) -> Result<u32, WasiErrno> {
    if fdflags.unknown_bits() != 0 {
        return Err(WasiErrno::Inval);
    }
    if fdflags.intersects(WasiFdflags::SYNC_BITS) {
        return Err(WasiErrno::NotSup);
    }
    let mut out = 0u32;
    if fdflags.contains(WasiFdflags::APPEND) {
        out |= flags::O_APPEND;
    }
    if fdflags.contains(WasiFdflags::NONBLOCK) {
        out |= flags::O_NONBLOCK;
    }
    Ok(out)
}

/// The `fcntl` command pair `fd_fdstat_set_flags` drives.
pub const F_GETFL: u32 = fcntl_cmd::F_GETFL;
pub const F_SETFL: u32 = fcntl_cmd::F_SETFL;

/// **DEFECT FIX 2** -- `path_filestat_get` ignoring `lookupflags`.
///
/// `pathFilestatGet` (`host/src/wasi-shim.ts:1258`) names its first parameter
/// `_flags` and passes a literal `0` to `SYS_FSTATAT`, so it *always* follows
/// symlinks and WASI's `lstat` (`lookupflags == 0`) is unreachable.
///
/// The correct mapping is the inverse of the bit's name: `SYMLINK_FOLLOW`
/// present means follow (no `at` flag), absent means do not follow
/// (`AT_SYMLINK_NOFOLLOW`).
pub const fn wasi_lookupflags_to_at_flags(lookupflags: WasiLookupflags) -> u32 {
    if lookupflags.contains(WasiLookupflags::SYMLINK_FOLLOW) {
        0
    } else {
        flags::AT_SYMLINK_NOFOLLOW
    }
}

/// **DEFECT FIX 1** -- `poll_oneoff`'s non-exhaustive tag handling.
///
/// `pollOneoff` (`host/src/wasi-shim.ts:1461`) computes
/// `tag === FD_READ ? POLLIN : POLLOUT`, so every tag that is not `FD_READ` --
/// `FD_WRITE`, but equally a malformed or future tag -- is silently treated as
/// a write subscription. `WASI_EVENTTYPE_FD_WRITE` is declared and never
/// compared against.
///
/// An exhaustive `match` cannot express that bug. A `Clock` tag is not a
/// pollfd subscription at all and is reported as such; an undefined tag is
/// `Inval`.
pub const fn poll_events_for_eventtype(tag: u8) -> Result<Option<u16>, WasiErrno> {
    match WasiEventType::from_u8(tag) {
        // Handled by the timeout, not by a pollfd entry.
        Some(WasiEventType::Clock) => Ok(None),
        Some(WasiEventType::FdRead) => Ok(Some(poll_events::POLLIN)),
        Some(WasiEventType::FdWrite) => Ok(Some(poll_events::POLLOUT)),
        None => Err(WasiErrno::Inval),
    }
}

/// Split a signed 64-bit value into the low unsigned word and the high signed
/// word, the way `splitSignedI64Words` (`host/src/wasi-shim.ts:126`) must.
///
/// Rust does not need this: an `i64` argument is simply an `i64`. It exists so
/// the differential harness can *prove* the TypeScript's BigInt word-splitting
/// was correct across the i64 boundaries before that code is retired. It is
/// not called by any entry point.
pub const fn split_signed_i64_words(value: i64) -> (u32, i32) {
    (value as u64 as u32, (value >> 32) as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetype_covers_every_ifmt_bucket() {
        assert_eq!(mode_to_filetype(mode::S_IFREG | 0o644), WasiFiletype::RegularFile);
        assert_eq!(mode_to_filetype(mode::S_IFDIR | 0o755), WasiFiletype::Directory);
        assert_eq!(mode_to_filetype(mode::S_IFLNK | 0o777), WasiFiletype::SymbolicLink);
        assert_eq!(mode_to_filetype(mode::S_IFCHR), WasiFiletype::CharacterDevice);
        assert_eq!(mode_to_filetype(mode::S_IFBLK), WasiFiletype::BlockDevice);
        assert_eq!(mode_to_filetype(mode::S_IFSOCK), WasiFiletype::SocketStream);
        // No WASI FIFO filetype exists; a char device is the closest.
        assert_eq!(mode_to_filetype(mode::S_IFIFO), WasiFiletype::CharacterDevice);
        assert_eq!(mode_to_filetype(0), WasiFiletype::Unknown);
    }

    #[test]
    fn low_mode_bits_never_affect_the_filetype() {
        for low in 0u32..0o1000 {
            assert_eq!(mode_to_filetype(mode::S_IFREG | low), WasiFiletype::RegularFile);
        }
    }

    #[test]
    fn whence_rejects_undefined_values() {
        assert_eq!(wasi_whence_to_posix(0), Some(seek::SEEK_SET));
        assert_eq!(wasi_whence_to_posix(1), Some(seek::SEEK_CUR));
        assert_eq!(wasi_whence_to_posix(2), Some(seek::SEEK_END));
        for probe in 3u32..=8 {
            assert_eq!(wasi_whence_to_posix(probe), None);
        }
    }

    #[test]
    fn clock_strict_and_lenient_differ_exactly_on_undefined_inputs() {
        for probe in 0u32..=3 {
            assert_eq!(wasi_clock_to_posix(probe), Some(probe));
            assert_eq!(wasi_clock_to_posix_lenient(probe), probe);
        }
        for probe in 4u32..=8 {
            assert_eq!(wasi_clock_to_posix(probe), None);
            // The bug-compatible path silently answers REALTIME.
            assert_eq!(wasi_clock_to_posix_lenient(probe), posix_clock::CLOCK_REALTIME);
        }
    }

    #[test]
    fn oflags_map_each_bit_independently() {
        assert_eq!(wasi_oflags_to_posix(WasiOflags::EMPTY, WasiFdflags::EMPTY), 0);
        assert_eq!(
            wasi_oflags_to_posix(WasiOflags::CREAT, WasiFdflags::EMPTY),
            flags::O_CREAT
        );
        assert_eq!(
            wasi_oflags_to_posix(WasiOflags::DIRECTORY, WasiFdflags::EMPTY),
            flags::O_DIRECTORY
        );
        assert_eq!(
            wasi_oflags_to_posix(WasiOflags::EXCL, WasiFdflags::EMPTY),
            flags::O_EXCL
        );
        assert_eq!(
            wasi_oflags_to_posix(WasiOflags::TRUNC, WasiFdflags::EMPTY),
            flags::O_TRUNC
        );
        assert_eq!(
            wasi_oflags_to_posix(WasiOflags::EMPTY, WasiFdflags::APPEND),
            flags::O_APPEND
        );
        assert_eq!(
            wasi_oflags_to_posix(WasiOflags::EMPTY, WasiFdflags::NONBLOCK),
            flags::O_NONBLOCK
        );
        // The synchronised-write bits contribute nothing on the open path,
        // which matches the TypeScript.
        assert_eq!(
            wasi_oflags_to_posix(WasiOflags::EMPTY, WasiFdflags::SYNC_BITS),
            0
        );
    }

    #[test]
    fn fdflags_round_trip_the_two_bits_the_kernel_tracks() {
        assert_eq!(posix_flags_to_wasi_fdflags(0), WasiFdflags::EMPTY);
        assert_eq!(
            posix_flags_to_wasi_fdflags(flags::O_APPEND),
            WasiFdflags::APPEND
        );
        assert_eq!(
            posix_flags_to_wasi_fdflags(flags::O_NONBLOCK),
            WasiFdflags::NONBLOCK
        );
        assert_eq!(
            posix_flags_to_wasi_fdflags(flags::O_APPEND | flags::O_NONBLOCK),
            WasiFdflags::APPEND.union(WasiFdflags::NONBLOCK)
        );
        // Unrelated POSIX bits must not leak into the WASI answer.
        assert_eq!(
            posix_flags_to_wasi_fdflags(flags::O_CREAT | flags::O_TRUNC),
            WasiFdflags::EMPTY
        );
    }

    #[test]
    fn defect_fix_3_refuses_synchronised_writes_instead_of_lying() {
        assert_eq!(wasi_fdflags_to_setfl(WasiFdflags::EMPTY), Ok(0));
        assert_eq!(
            wasi_fdflags_to_setfl(WasiFdflags::APPEND),
            Ok(flags::O_APPEND)
        );
        assert_eq!(
            wasi_fdflags_to_setfl(WasiFdflags::NONBLOCK),
            Ok(flags::O_NONBLOCK)
        );
        for sync in [WasiFdflags::DSYNC, WasiFdflags::RSYNC, WasiFdflags::SYNC] {
            assert_eq!(wasi_fdflags_to_setfl(sync), Err(WasiErrno::NotSup));
            // Even combined with a bit that IS supported: the request as a
            // whole cannot be honored, so it must not report success.
            assert_eq!(
                wasi_fdflags_to_setfl(sync.union(WasiFdflags::APPEND)),
                Err(WasiErrno::NotSup)
            );
        }
        assert_eq!(wasi_fdflags_to_setfl(WasiFdflags(32)), Err(WasiErrno::Inval));
    }

    #[test]
    fn defect_fix_2_makes_lstat_reachable() {
        assert_eq!(
            wasi_lookupflags_to_at_flags(WasiLookupflags::SYMLINK_FOLLOW),
            0
        );
        // lookupflags == 0 is WASI's lstat, and must NOT follow the link.
        assert_eq!(
            wasi_lookupflags_to_at_flags(WasiLookupflags::EMPTY),
            flags::AT_SYMLINK_NOFOLLOW
        );
    }

    #[test]
    fn defect_fix_1_rejects_undefined_poll_tags() {
        assert_eq!(poll_events_for_eventtype(0), Ok(None));
        assert_eq!(poll_events_for_eventtype(1), Ok(Some(poll_events::POLLIN)));
        assert_eq!(poll_events_for_eventtype(2), Ok(Some(poll_events::POLLOUT)));
        // The TypeScript answers POLLOUT for every one of these.
        for probe in 3u8..=255 {
            assert_eq!(poll_events_for_eventtype(probe), Err(WasiErrno::Inval));
        }
    }

    #[test]
    fn i64_word_split_matches_at_the_boundaries() {
        assert_eq!(split_signed_i64_words(0), (0, 0));
        assert_eq!(split_signed_i64_words(-1), (u32::MAX, -1));
        assert_eq!(split_signed_i64_words(i64::MAX), (u32::MAX, i32::MAX));
        assert_eq!(split_signed_i64_words(i64::MIN), (0, i32::MIN));
        assert_eq!(split_signed_i64_words(0x0123_4567_89AB_CDEF), (0x89AB_CDEF, 0x0123_4567));
        // Reassembly must be lossless for every case above.
        for probe in [0i64, -1, 1, i64::MAX, i64::MIN, 0x0123_4567_89AB_CDEF, -0x0123_4567_89AB_CDEF] {
            let (low, high) = split_signed_i64_words(probe);
            assert_eq!(((high as i64) << 32) | (low as i64), probe);
        }
    }
}
