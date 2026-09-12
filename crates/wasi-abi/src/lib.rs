//! WASI Preview 1 <-> POSIX translation.
//!
//! This crate is the *pure* half of Kandelo's WASI support: the constants the
//! WASI specification fixes, the Linux -> WASI errno table, the scalar
//! translation functions, and the binary struct layouts. It makes no
//! assumptions about wasm, linear memory, the syscall channel, or a host, so
//! all of it is exercised by an ordinary `cargo test -p wasi-abi` on the host
//! target.
//!
//! The stateful half -- the preopen table, the channel syscall, and the 46
//! guest-facing entry points -- lives in `crates/wasi-module`, which is built
//! as a co-resident PIC wasm side module and depends on this crate.
//!
//! ## Why this is not a Kandelo ABI surface
//!
//! `wasi_snapshot_preview1` is a *guest* ABI defined by the WASI
//! specification. It is not part of Kandelo's kernel<->host contract, appears
//! nowhere in `abi/snapshot.json`, and needs no `ABI_VERSION` motion. POSIX
//! constants are never redeclared here; they are imported from
//! `wasm_posix_shared`, which is already their single source of truth.
//!
//! ## Deliberate divergences from `host/src/wasi-shim.ts`
//!
//! The TypeScript this replaces carries five latent defects. They are fixed
//! here rather than transliterated, each marked **DEFECT FIX** at its
//! definition, because a differential harness that certified them would be
//! certifying wrong behavior as correct:
//!
//! 1. `poll_oneoff` treats every non-`FD_READ` tag -- including a malformed
//!    one -- as `FD_WRITE`. See [`translate::poll_events_for_eventtype`].
//! 2. `path_filestat_get` ignores `lookupflags`, so WASI's `lstat` is
//!    unreachable. See [`translate::wasi_lookupflags_to_at_flags`].
//! 3. `fd_fdstat_set_flags` reports success for `O_SYNC`/`O_DSYNC`/`O_RSYNC`
//!    without honoring them. See [`translate::wasi_fdflags_to_setfl`].
//! 4. `translateStat` reads the kernel stat at hand-written offsets while
//!    importing and ignoring `WASM_STAT_SIZE`; two of those reads straddle
//!    struct padding. See [`layout::wasm_stat`].
//! 5. `fd_readdir`'s cookie handling drops entries past the first
//!    `getdents64` batch. The decoding half lives in
//!    [`layout::decode_linux_dirent`]; the cursor itself is `wasi-module`'s.
//!
//! 6. `wasiClockToPosix` silently defaults an undefined clock to
//!    `CLOCK_REALTIME`, so a guest asking for a clock Kandelo does not
//!    implement is handed a different one with no way to detect the
//!    substitution. Surfaced during the port and fixed by maintainer decision
//!    (2026-09-09) as the same class of violation as the other five. See
//!    [`translate::wasi_clock_to_posix`]; the TypeScript's behavior survives
//!    only as [`translate::wasi_clock_to_posix_lenient`], which no entry
//!    point calls and which exists purely for the differential harness.

#![no_std]
#![forbid(unsafe_code)]

pub mod errno;
pub mod layout;
pub mod translate;
pub mod types;

pub use errno::{translate_errno, translate_linux_errno, WasiErrno};
pub use types::{
    WasiClock, WasiEventType, WasiFdflags, WasiFiletype, WasiLookupflags, WasiOflags, WasiWhence,
    WASI_PREOPENTYPE_DIR, WASI_RIGHTS_ALL,
};
