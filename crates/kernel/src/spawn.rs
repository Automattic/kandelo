//! Non-forking spawn — types shared between the host-side blob parser
//! (in `host/src/kernel-worker.ts`) and the kernel's
//! `ProcessTable::spawn_child` implementation.
//!
//! See `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`.

extern crate alloc;

use alloc::vec::Vec;
use core::cell::UnsafeCell;
use wasm_posix_shared::{spawn_contract, Errno};

/// Kernel-owned reusable transport for SYS_SPAWN blobs larger than the normal
/// syscall-channel scratch region.
///
/// The host may write only the pointer/capacity pair returned by `reserve`.
/// Growing may move the allocation, so no caller may retain an older pointer
/// across a reserve call.
struct SpawnScratchBuffer {
    bytes: Vec<u8>,
}

impl SpawnScratchBuffer {
    const fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn reserve(&mut self, minimum_capacity: usize) -> Result<(usize, usize), Errno> {
        if minimum_capacity == 0 {
            return Err(Errno::EINVAL);
        }
        if minimum_capacity > spawn_contract::WIRE_MAX_BYTES {
            return Err(Errno::E2BIG);
        }
        if self.bytes.len() < minimum_capacity {
            self.bytes
                .try_reserve_exact(minimum_capacity - self.bytes.len())
                .map_err(|_| Errno::ENOMEM)?;
            // Expose only initialized bytes to the host. `try_reserve_exact`
            // has already proven this resize cannot allocate or fail.
            let capacity = self.bytes.capacity();
            self.bytes.resize(capacity, 0);
        }
        Ok((self.bytes.as_mut_ptr() as usize, self.bytes.len()))
    }

    fn capacity(&self) -> usize {
        self.bytes.len()
    }
}

struct GlobalSpawnScratch(UnsafeCell<SpawnScratchBuffer>);

// SAFETY: the kernel Wasm instance runs in one dedicated worker and all direct
// export calls are serialized there. In particular, reserve/copy/parse is one
// synchronous host operation, so the Vec cannot be grown while its bytes are
// being consumed by `kernel_spawn_process`.
unsafe impl Sync for GlobalSpawnScratch {}

static SPAWN_SCRATCH: GlobalSpawnScratch =
    GlobalSpawnScratch(UnsafeCell::new(SpawnScratchBuffer::new()));

/// Reserve a kernel-owned region for a complete spawn blob.
///
/// The returned pointer is valid for exactly `spawn_scratch_capacity()` bytes
/// until the next call that grows this region.
pub fn reserve_spawn_scratch(minimum_capacity: usize) -> Result<usize, Errno> {
    let scratch = unsafe { &mut *SPAWN_SCRATCH.0.get() };
    scratch.reserve(minimum_capacity).map(|(pointer, _)| pointer)
}

pub fn spawn_scratch_capacity() -> usize {
    let scratch = unsafe { &*SPAWN_SCRATCH.0.get() };
    scratch.capacity()
}

/// Bit flags from `posix_spawnattr_t::__flags`. Values match POSIX / musl
/// (`libc/musl/include/spawn.h`):
///
/// ```text
///   POSIX_SPAWN_RESETIDS      = 1
///   POSIX_SPAWN_SETPGROUP     = 2
///   POSIX_SPAWN_SETSIGDEF     = 4
///   POSIX_SPAWN_SETSIGMASK    = 8
///   POSIX_SPAWN_SETSCHEDPARAM = 16
///   POSIX_SPAWN_SETSCHEDULER  = 32
///   POSIX_SPAWN_USEVFORK      = 64
///   POSIX_SPAWN_SETSID        = 128
/// ```
///
/// `posix_spawn.c` passes `a->__flags` into the SYS_SPAWN blob unmodified,
/// so these values must align byte-for-byte with the libc constants.
pub mod attr_flags {
    pub const SETPGROUP: u32 = 0x02;
    pub const SETSIGDEF: u32 = 0x04;
    pub const SETSIGMASK: u32 = 0x08;
    pub const SETSID: u32 = 0x80;
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
        Self {
            flags: 0,
            pgrp: 0,
            sigdef: 0,
            sigmask: 0,
        }
    }
}

/// One entry from a `posix_spawn_file_actions_t`. Path strings (for `Open`
/// and `Chdir`) are owned `Vec<u8>` — the host-side blob parser copies them
/// out of caller memory before handing the parsed action list to the kernel.
#[derive(Debug, Clone)]
pub enum FileAction {
    /// FDOP_OPEN: open `path` with `oflag`/`mode`, then arrange for the
    /// resulting fd to land at `fd` (closing any prior occupant).
    Open {
        fd: i32,
        path: Vec<u8>,
        oflag: i32,
        mode: u32,
    },
    /// FDOP_CLOSE: `close(fd)`. Errors are ignored (POSIX behavior).
    Close { fd: i32 },
    /// FDOP_DUP2: `dup2(srcfd, fd)`. If `srcfd == fd`, clear FD_CLOEXEC on `fd`.
    Dup2 { srcfd: i32, fd: i32 },
    /// FDOP_CHDIR: `chdir(path)` in the child only.
    Chdir { path: Vec<u8> },
    /// FDOP_FCHDIR: `fchdir(fd)` in the child only.
    Fchdir { fd: i32 },
}

// ── SYS_SPAWN blob parser ─────────────────────────────────────────────────
//
// Wire format (little-endian, from
// `docs/plans/2026-05-04-non-forking-posix-spawn-design.md` Section 1):
//
//   header (`spawn_contract::WIRE_HEADER_BYTES`):
//       argc:u32  envc:u32  n_actions:u32  attr_flags:u32
//       pgrp:i32  _pad:u32  sigdef:u64     sigmask:u64
//   argv_offsets:    u32 × argc                (offsets into strings[])
//   envp_offsets:    u32 × envc
//   actions:         action_record × n_actions
//   strings:         u8[]                       (null-terminated entries)
//
// `action_record = { op:u32, fd:i32, newfd:i32, path_off:u32, path_len:u32,
//                    oflag:i32, mode:u32 }`
//
// This is the trust boundary between user code and the kernel — every read
// is range-checked and any malformed offset/length yields `Errno::EINVAL`.

/// File-action `op` codes shared with `libc/glue/posix_spawn.c`.
pub mod fdop {
    pub const OPEN: u32 = 0;
    pub const CLOSE: u32 = 1;
    pub const DUP2: u32 = 2;
    pub const CHDIR: u32 = 3;
    pub const FCHDIR: u32 = 4;
}

/// Parsed view over a SYS_SPAWN blob. argv/envp/path bytes are owned (copied
/// out of the blob) so the caller is free to drop the underlying buffer
/// before feeding this into `ProcessTable::spawn_child`.
#[derive(Debug)]
pub struct ParsedBlob {
    pub argv: Vec<Vec<u8>>,
    pub envp: Vec<Vec<u8>>,
    pub file_actions: Vec<FileAction>,
    pub attrs: SpawnAttrs,
}

/// Read a little-endian `u32` at `off`, or `Err(EINVAL)` if out of range.
fn read_u32(bytes: &[u8], off: usize) -> Result<u32, Errno> {
    let slice = bytes.get(off..off + 4).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32(bytes: &[u8], off: usize) -> Result<i32, Errno> {
    Ok(read_u32(bytes, off)? as i32)
}

fn read_u64(bytes: &[u8], off: usize) -> Result<u64, Errno> {
    let slice = bytes.get(off..off + 8).ok_or(Errno::EINVAL)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(slice);
    Ok(u64::from_le_bytes(buf))
}

/// Resolve a `(off, len)` pair against the strings region — both must be
/// in-bounds and `len` must include exactly one trailing NUL or no NUL at
/// all (the parser strips trailing NUL).
fn read_string(strings: &[u8], off: u32, len: u32) -> Result<Vec<u8>, Errno> {
    let off = off as usize;
    let len = len as usize;
    let raw = strings
        .get(off..off.checked_add(len).ok_or(Errno::EINVAL)?)
        .ok_or(Errno::EINVAL)?;
    // Permit either a trailing NUL or no NUL.
    let trimmed = if raw.last() == Some(&0u8) {
        &raw[..raw.len() - 1]
    } else {
        raw
    };
    if trimmed.len() >= spawn_contract::POSIX_PATH_MAX_BYTES {
        return Err(Errno::ENAMETOOLONG);
    }
    if trimmed.contains(&0) {
        return Err(Errno::EINVAL);
    }
    Ok(trimmed.to_vec())
}

/// Parse a SYS_SPAWN blob. Bails with `Errno::EINVAL` on any malformed
/// offset, length, or op code.
pub fn parse_blob(bytes: &[u8]) -> Result<ParsedBlob, Errno> {
    if bytes.len() > spawn_contract::WIRE_MAX_BYTES {
        return Err(Errno::E2BIG);
    }
    if bytes.len() < spawn_contract::WIRE_HEADER_BYTES {
        return Err(Errno::EINVAL);
    }
    let argc = read_u32(bytes, 0)? as usize;
    let envc = read_u32(bytes, 4)? as usize;
    let n_actions = read_u32(bytes, 8)? as usize;
    let attr_flags = read_u32(bytes, 12)?;
    let pgrp = read_i32(bytes, 16)?;
    // bytes 20..24 = _pad
    let sigdef = read_u64(bytes, 24)?;
    let sigmask = read_u64(bytes, 32)?;

    // Cap counts to avoid pathological allocations on malformed input.
    // Real callers would never approach these limits.
    if argc > spawn_contract::MAX_ARGV_COUNT
        || envc > spawn_contract::MAX_ENVP_COUNT
        || n_actions > spawn_contract::MAX_ACTION_COUNT
    {
        return Err(Errno::EINVAL);
    }

    let mut cursor = spawn_contract::WIRE_HEADER_BYTES;

    // Argv offsets table.
    let argv_offsets_size = argc.checked_mul(4).ok_or(Errno::EINVAL)?;
    let argv_offsets_end = cursor.checked_add(argv_offsets_size).ok_or(Errno::EINVAL)?;
    let argv_offsets_bytes = bytes.get(cursor..argv_offsets_end).ok_or(Errno::EINVAL)?;
    let mut argv_offsets: Vec<u32> = Vec::with_capacity(argc);
    for i in 0..argc {
        argv_offsets.push(read_u32(argv_offsets_bytes, i * 4)?);
    }
    cursor = argv_offsets_end;

    // Envp offsets table.
    let envp_offsets_size = envc.checked_mul(4).ok_or(Errno::EINVAL)?;
    let envp_offsets_end = cursor.checked_add(envp_offsets_size).ok_or(Errno::EINVAL)?;
    let envp_offsets_bytes = bytes.get(cursor..envp_offsets_end).ok_or(Errno::EINVAL)?;
    let mut envp_offsets: Vec<u32> = Vec::with_capacity(envc);
    for i in 0..envc {
        envp_offsets.push(read_u32(envp_offsets_bytes, i * 4)?);
    }
    cursor = envp_offsets_end;

    // Action records.
    let actions_size = n_actions
        .checked_mul(spawn_contract::WIRE_ACTION_RECORD_BYTES)
        .ok_or(Errno::EINVAL)?;
    let actions_end = cursor.checked_add(actions_size).ok_or(Errno::EINVAL)?;
    let actions_bytes = bytes.get(cursor..actions_end).ok_or(Errno::EINVAL)?;
    cursor = actions_end;

    // Everything left is the strings region.
    let strings = bytes.get(cursor..).ok_or(Errno::EINVAL)?;

    // Decode argv + envp using the offset tables. Each offset points at a
    // null-terminated string in `strings`. A length isn't carried in the
    // table, so we walk to the next NUL — but bounded by `strings.len()` so
    // a malformed blob can't read past the end.
    let argv = decode_strings_by_offset(&argv_offsets, strings)?;
    let envp = decode_strings_by_offset(&envp_offsets, strings)?;
    // ARG_MAX accounts for the source pointer arrays as well as the string
    // bytes. Four-byte pointers are the smaller supported representation, so
    // this rejects a blob that could not have been valid on either wasm32 or
    // wasm64 while leaving the host's source-width check authoritative.
    let pointer_bytes = argc
        .checked_add(envc)
        .and_then(|count| count.checked_add(2))
        .and_then(|count| count.checked_mul(4))
        .ok_or(Errno::E2BIG)?;
    let represented_bytes = argv
        .iter()
        .chain(envp.iter())
        .try_fold(pointer_bytes, |total, value| {
            total.checked_add(value.len()).and_then(|n| n.checked_add(1))
        })
        .ok_or(Errno::E2BIG)?;
    if represented_bytes > spawn_contract::POSIX_ARG_MAX_BYTES {
        return Err(Errno::E2BIG);
    }

    // Decode action records.
    let mut file_actions: Vec<FileAction> = Vec::with_capacity(n_actions);
    for i in 0..n_actions {
        let base = i * spawn_contract::WIRE_ACTION_RECORD_BYTES;
        let op = read_u32(actions_bytes, base)?;
        let fd = read_i32(actions_bytes, base + 4)?;
        let newfd = read_i32(actions_bytes, base + 8)?;
        let path_off = read_u32(actions_bytes, base + 12)?;
        let path_len = read_u32(actions_bytes, base + 16)?;
        let oflag = read_i32(actions_bytes, base + 20)?;
        let mode = read_u32(actions_bytes, base + 24)?;
        let action = match op {
            x if x == fdop::OPEN => FileAction::Open {
                fd,
                path: read_string(strings, path_off, path_len)?,
                oflag,
                mode,
            },
            x if x == fdop::CLOSE => FileAction::Close { fd },
            x if x == fdop::DUP2 => FileAction::Dup2 {
                srcfd: fd,
                fd: newfd,
            },
            x if x == fdop::CHDIR => FileAction::Chdir {
                path: read_string(strings, path_off, path_len)?,
            },
            x if x == fdop::FCHDIR => FileAction::Fchdir { fd },
            _ => return Err(Errno::EINVAL),
        };
        file_actions.push(action);
    }

    Ok(ParsedBlob {
        argv,
        envp,
        file_actions,
        attrs: SpawnAttrs {
            flags: attr_flags,
            pgrp,
            sigdef,
            sigmask,
        },
    })
}

/// Decode a list of NUL-terminated strings out of `strings` at the given
/// byte offsets. Each offset must be in range; the string runs to the next
/// NUL within `strings` (and a missing terminator is permitted as long as
/// the slice ends at the buffer end).
fn decode_strings_by_offset(offsets: &[u32], strings: &[u8]) -> Result<Vec<Vec<u8>>, Errno> {
    let mut out: Vec<Vec<u8>> = Vec::with_capacity(offsets.len());
    for &off in offsets {
        let off = off as usize;
        if off > strings.len() {
            return Err(Errno::EINVAL);
        }
        let tail = &strings[off..];
        let end = tail.iter().position(|&b| b == 0).unwrap_or(tail.len());
        out.push(tail[..end].to_vec());
    }
    Ok(out)
}

#[cfg(test)]
mod parser_tests {
    use super::*;

    #[test]
    fn growable_scratch_reports_owned_capacity_and_reuses_or_replaces_safely() {
        let mut scratch = SpawnScratchBuffer::new();
        assert_eq!(scratch.reserve(0), Err(Errno::EINVAL));
        assert_eq!(
            scratch.reserve(spawn_contract::WIRE_MAX_BYTES + 1),
            Err(Errno::E2BIG)
        );

        let (first_pointer, first_capacity) =
            scratch.reserve(84 * 1024).expect("first reserve");
        assert_ne!(first_pointer, 0);
        assert!(first_capacity >= 84 * 1024);
        assert_eq!(scratch.capacity(), first_capacity);

        let (reused_pointer, reused_capacity) =
            scratch.reserve(80 * 1024).expect("reuse");
        assert_eq!(reused_pointer, first_pointer);
        assert_eq!(reused_capacity, first_capacity);

        let (grown_pointer, grown_capacity) =
            scratch.reserve(first_capacity + 1).expect("grow");
        assert_ne!(grown_pointer, 0);
        assert!(grown_capacity > first_capacity);
        assert_eq!(scratch.capacity(), grown_capacity);
    }

    /// Build a well-formed blob with a single argv entry, a single envp
    /// entry, one Close action, and SETPGROUP attrs. Used to anchor the
    /// happy-path round-trip test.
    fn build_basic_blob() -> Vec<u8> {
        let mut blob: Vec<u8> = Vec::new();
        // ── header ──
        blob.extend_from_slice(&1u32.to_le_bytes()); // argc
        blob.extend_from_slice(&1u32.to_le_bytes()); // envc
        blob.extend_from_slice(&1u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&attr_flags::SETPGROUP.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&7i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        // ── argv offsets (1) ──
        blob.extend_from_slice(&0u32.to_le_bytes()); // argv[0] @ strings[0]
        // ── envp offsets (1) ──
        blob.extend_from_slice(&8u32.to_le_bytes()); // envp[0] @ strings[8]
        // ── actions (1) ──   FDOP_CLOSE on fd 5
        blob.extend_from_slice(&fdop::CLOSE.to_le_bytes());
        blob.extend_from_slice(&5i32.to_le_bytes()); // fd
        blob.extend_from_slice(&0i32.to_le_bytes()); // newfd
        blob.extend_from_slice(&0u32.to_le_bytes()); // path_off
        blob.extend_from_slice(&0u32.to_le_bytes()); // path_len
        blob.extend_from_slice(&0i32.to_le_bytes()); // oflag
        blob.extend_from_slice(&0u32.to_le_bytes()); // mode
        // ── strings ──
        blob.extend_from_slice(b"/bin/ls\0"); // strings[0..7]
        blob.extend_from_slice(b"PATH=/usr/bin\0"); // strings[7..]
        blob
    }

    #[test]
    fn parse_blob_basic_round_trip() {
        let blob = build_basic_blob();
        let parsed = parse_blob(&blob).expect("parse");
        assert_eq!(parsed.argv, alloc::vec![b"/bin/ls".to_vec()]);
        assert_eq!(parsed.envp, alloc::vec![b"PATH=/usr/bin".to_vec()]);
        assert_eq!(parsed.file_actions.len(), 1);
        match &parsed.file_actions[0] {
            FileAction::Close { fd } => assert_eq!(*fd, 5),
            _ => panic!("expected Close action"),
        }
        assert_eq!(parsed.attrs.flags, attr_flags::SETPGROUP);
        assert_eq!(parsed.attrs.pgrp, 7);
    }

    #[test]
    fn parse_blob_rejects_short_header() {
        // Truncate to 39 bytes.
        let blob = build_basic_blob();
        let truncated = &blob[..39];
        assert!(matches!(parse_blob(truncated), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_truncated_argv_offsets() {
        // argc=4 means we expect 16 bytes of argv_offsets after the header,
        // but we only provide 0 strings region after.
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&4u32.to_le_bytes()); // argc=4 (table will be missing)
        blob.extend_from_slice(&0u32.to_le_bytes()); // envc
        blob.extend_from_slice(&0u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&0u32.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&0i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        // No argv_offsets follow → out of range.
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_action_path_out_of_bounds() {
        // n_actions=1, FDOP_CHDIR with path_off=999 (out of range).
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&0u32.to_le_bytes()); // argc
        blob.extend_from_slice(&0u32.to_le_bytes()); // envc
        blob.extend_from_slice(&1u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&0u32.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&0i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        // No argv/envp offsets, then one action record:
        blob.extend_from_slice(&fdop::CHDIR.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes()); // fd
        blob.extend_from_slice(&0i32.to_le_bytes()); // newfd
        blob.extend_from_slice(&999u32.to_le_bytes()); // path_off (oversized)
        blob.extend_from_slice(&5u32.to_le_bytes()); // path_len
        blob.extend_from_slice(&0i32.to_le_bytes()); // oflag
        blob.extend_from_slice(&0u32.to_le_bytes()); // mode
        blob.extend_from_slice(b"/x\0"); // small strings region
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_unknown_op() {
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&0u32.to_le_bytes()); // argc
        blob.extend_from_slice(&0u32.to_le_bytes()); // envc
        blob.extend_from_slice(&1u32.to_le_bytes()); // n_actions
        blob.extend_from_slice(&0u32.to_le_bytes()); // attr_flags
        blob.extend_from_slice(&0i32.to_le_bytes()); // pgrp
        blob.extend_from_slice(&0u32.to_le_bytes()); // _pad
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigdef
        blob.extend_from_slice(&0u64.to_le_bytes()); // sigmask
        blob.extend_from_slice(&99u32.to_le_bytes()); // op = 99 (unknown)
        blob.extend_from_slice(&[
            0u8;
            spawn_contract::WIRE_ACTION_RECORD_BYTES - 4
        ]);
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_argv_overflow() {
        // argc set to a huge value that would multiply-overflow.
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&u32::MAX.to_le_bytes());
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob.extend_from_slice(&[
            0u8;
            spawn_contract::WIRE_HEADER_BYTES - 12
        ]);
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    fn header(argc: u32, envc: u32, n_actions: u32) -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(&argc.to_le_bytes());
        blob.extend_from_slice(&envc.to_le_bytes());
        blob.extend_from_slice(&n_actions.to_le_bytes());
        blob.extend_from_slice(&[0u8; spawn_contract::WIRE_HEADER_BYTES - 12]);
        blob
    }

    #[test]
    fn parse_blob_rejects_each_count_at_limit_plus_one() {
        for (argc, envc, n_actions) in [
            ((spawn_contract::MAX_ARGV_COUNT + 1) as u32, 0, 0),
            (0, (spawn_contract::MAX_ENVP_COUNT + 1) as u32, 0),
            (0, 0, (spawn_contract::MAX_ACTION_COUNT + 1) as u32),
        ] {
            assert!(matches!(
                parse_blob(&header(argc, envc, n_actions)),
                Err(Errno::EINVAL)
            ));
        }
    }

    #[test]
    fn parse_blob_rejects_truncated_tables_at_each_exact_count_cap() {
        for (argc, envc, n_actions) in [
            (spawn_contract::MAX_ARGV_COUNT as u32, 0, 0),
            (0, spawn_contract::MAX_ENVP_COUNT as u32, 0),
            (0, 0, spawn_contract::MAX_ACTION_COUNT as u32),
        ] {
            assert!(matches!(
                parse_blob(&header(argc, envc, n_actions)),
                Err(Errno::EINVAL)
            ));
        }
    }

    #[test]
    fn parse_blob_accepts_exact_arg_max_and_rejects_arg_max_plus_one() {
        // One argv pointer, its terminator, and the envp terminator consume
        // twelve bytes of the wasm32 source representation.
        let string_bytes = spawn_contract::POSIX_ARG_MAX_BYTES - 12;
        let mut exact = header(1, 0, 0);
        exact.extend_from_slice(&0u32.to_le_bytes());
        exact.extend(core::iter::repeat_n(b'a', string_bytes - 1));
        exact.push(0);
        assert!(parse_blob(&exact).is_ok());

        let mut oversized = exact;
        oversized.insert(oversized.len() - 1, b'a');
        assert!(matches!(parse_blob(&oversized), Err(Errno::E2BIG)));
    }

    #[test]
    fn parse_blob_bounds_action_paths_by_path_max() {
        fn action_blob(path_bytes: usize) -> Vec<u8> {
            let mut blob = header(0, 0, 1);
            blob.extend_from_slice(&fdop::CHDIR.to_le_bytes());
            blob.extend_from_slice(&0i32.to_le_bytes());
            blob.extend_from_slice(&0i32.to_le_bytes());
            blob.extend_from_slice(&0u32.to_le_bytes());
            blob.extend_from_slice(&(path_bytes as u32).to_le_bytes());
            blob.extend_from_slice(&0i32.to_le_bytes());
            blob.extend_from_slice(&0u32.to_le_bytes());
            blob.extend(core::iter::repeat_n(b'a', path_bytes - 1));
            blob.push(0);
            blob
        }

        assert!(parse_blob(&action_blob(spawn_contract::POSIX_PATH_MAX_BYTES)).is_ok());
        assert!(matches!(
            parse_blob(&action_blob(spawn_contract::POSIX_PATH_MAX_BYTES + 1)),
            Err(Errno::ENAMETOOLONG)
        ));
    }

    #[test]
    fn parse_blob_rejects_an_interior_nul_in_an_action_path() {
        let mut blob = header(0, 0, 1);
        blob.extend_from_slice(&fdop::CHDIR.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes());
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob.extend_from_slice(&4u32.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes());
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob.extend_from_slice(b"a\0b\0");
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_whole_blob_limit_plus_one() {
        let blob = alloc::vec![0; spawn_contract::WIRE_MAX_BYTES + 1];
        assert!(matches!(parse_blob(&blob), Err(Errno::E2BIG)));
    }
}
