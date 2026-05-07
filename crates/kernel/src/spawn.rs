//! Non-forking spawn — types shared between the host-side blob parser
//! (in `host/src/kernel-worker.ts`) and the kernel's
//! `ProcessTable::spawn_child` implementation.
//!
//! See `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`.

extern crate alloc;

use alloc::vec::Vec;

/// Bit flags from `posix_spawnattr_t::__flags`. Values match POSIX / musl
/// (`bits/posix_spawn.h`).
pub mod attr_flags {
    pub const SETPGROUP:  u32 = 0x02;
    pub const SETSIGMASK: u32 = 0x08;
    pub const SETSIGDEF:  u32 = 0x10;
    pub const SETSID:     u32 = 0x80;
}

/// Attributes carried by `posix_spawnattr_t`, parsed out of the SYS_SPAWN
/// blob by the host and handed to the kernel.
///
/// Only the attribute kinds we currently support land here. POSIX defines
/// additional ones (SETSCHEDPARAM, SETSCHEDULER, RESETIDS) that we don't
/// need yet — the host-side parser ignores them.
#[derive(Debug, Clone, Copy)]
pub struct SpawnAttrs {
    pub flags: u32,
    /// Target process group from POSIX_SPAWN_SETPGROUP. `0` means "make a
    /// new pgrp with pgid == child pid" (POSIX semantics).
    pub pgrp: i32,
    /// 64-bit signal-default mask from POSIX_SPAWN_SETSIGDEF (signals 1..64).
    /// Each set bit means "reset this signal's disposition to SIG_DFL in the
    /// child".
    pub sigdef: u64,
    /// 64-bit blocked-signal mask from POSIX_SPAWN_SETSIGMASK (signals 1..64).
    pub sigmask: u64,
}

impl SpawnAttrs {
    pub const fn empty() -> Self {
        Self { flags: 0, pgrp: 0, sigdef: 0, sigmask: 0 }
    }
}

/// One entry from a `posix_spawn_file_actions_t`. Path strings (for `Open`
/// and `Chdir`) are owned `Vec<u8>` — the host-side blob parser copies them
/// out of caller memory before handing the parsed action list to the kernel.
#[derive(Debug, Clone)]
pub enum FileAction {
    /// FDOP_OPEN: open `path` with `oflag`/`mode`, then arrange for the
    /// resulting fd to land at `fd` (closing any prior occupant).
    Open  { fd: i32, path: Vec<u8>, oflag: i32, mode: u32 },
    /// FDOP_CLOSE: `close(fd)`. Errors are ignored (POSIX behavior).
    Close { fd: i32 },
    /// FDOP_DUP2: `dup2(srcfd, fd)`. If `srcfd == fd`, clear FD_CLOEXEC on `fd`.
    Dup2  { srcfd: i32, fd: i32 },
    /// FDOP_CHDIR: `chdir(path)` in the child only.
    Chdir { path: Vec<u8> },
    /// FDOP_FCHDIR: `fchdir(fd)` in the child only.
    Fchdir { fd: i32 },
}
