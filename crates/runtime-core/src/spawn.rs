//! Non-forking spawn: the SYS_SPAWN request the kernel reads from the
//! caller's memory, and the types `ProcessTable::spawn_child` consumes.
//!
//! See `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`.

extern crate alloc;

use alloc::vec::Vec;
use wasm_posix_shared::{Errno, platform_limits, spawn_contract};

use crate::process::HostIO;

/// Implemented bits from `posix_spawnattr_t::__flags`.
///
/// `posix_spawn.c` transports every musl flag bit unmodified, and the complete
/// numeric contract lives in `wasm_posix_shared::spawn_contract`. Reexport only
/// the subset the process table actually interprets so a transport constant
/// cannot be mistaken for implemented POSIX behavior.
pub mod attr_flags {
    pub use wasm_posix_shared::spawn_contract::{
        ATTR_RESETIDS as RESETIDS, ATTR_SETPGROUP as SETPGROUP, ATTR_SETSID as SETSID,
        ATTR_SETSIGDEF as SETSIGDEF, ATTR_SETSIGMASK as SETSIGMASK,
    };
}

/// Attributes carried by `posix_spawnattr_t`, parsed out of the SYS_SPAWN
/// blob by the host and handed to the kernel.
///
/// Only the attribute kinds we currently support are interpreted. The
/// transported SETSCHEDPARAM, SETSCHEDULER, and USEVFORK bits remain visible in
/// `flags`, but the process table does not implement their behavior.
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
    pub use wasm_posix_shared::spawn_contract::{
        WIRE_OP_CHDIR as CHDIR, WIRE_OP_CLOSE as CLOSE, WIRE_OP_DUP2 as DUP2,
        WIRE_OP_FCHDIR as FCHDIR, WIRE_OP_OPEN as OPEN,
    };
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

/// Resolve an action-path `(off, len)` pair against the strings region.
///
/// `len` is musl's `strlen(path) + 1`, so the referenced range must contain
/// exactly one terminal NUL. WHY: accepting an absent or interior terminator
/// gives the producer and parser different path boundaries for the same wire
/// record.
fn read_action_path(strings: &[u8], off: u32, len: u32) -> Result<Vec<u8>, Errno> {
    let off = off as usize;
    let len = len as usize;
    let raw = strings
        .get(off..off.checked_add(len).ok_or(Errno::EINVAL)?)
        .ok_or(Errno::EINVAL)?;
    let (&terminator, path) = raw.split_last().ok_or(Errno::EINVAL)?;
    if terminator != 0 || path.contains(&0) {
        return Err(Errno::EINVAL);
    }
    if path.len() >= spawn_contract::POSIX_PATH_MAX_BYTES {
        return Err(Errno::ENAMETOOLONG);
    }
    Ok(path.to_vec())
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
    let argc = read_u32(bytes, spawn_contract::WIRE_HEADER_ARGC_OFFSET)? as usize;
    let envc = read_u32(bytes, spawn_contract::WIRE_HEADER_ENVC_OFFSET)? as usize;
    let n_actions = read_u32(bytes, spawn_contract::WIRE_HEADER_ACTION_COUNT_OFFSET)? as usize;
    let attr_flags = read_u32(bytes, spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET)?;
    let pgrp = read_i32(bytes, spawn_contract::WIRE_HEADER_PGRP_OFFSET)?;
    // WIRE_HEADER_PAD_OFFSET names the reserved u32; readers intentionally
    // ignore its value until a later ABI gives that field semantics.
    let sigdef = read_u64(bytes, spawn_contract::WIRE_HEADER_SIGDEF_OFFSET)?;
    let sigmask = read_u64(bytes, spawn_contract::WIRE_HEADER_SIGMASK_OFFSET)?;

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
    let argv_offsets_size = argc
        .checked_mul(spawn_contract::WIRE_STRING_OFFSET_BYTES)
        .ok_or(Errno::EINVAL)?;
    let argv_offsets_end = cursor.checked_add(argv_offsets_size).ok_or(Errno::EINVAL)?;
    let argv_offsets_bytes = bytes.get(cursor..argv_offsets_end).ok_or(Errno::EINVAL)?;
    let mut argv_offsets: Vec<u32> = Vec::with_capacity(argc);
    for i in 0..argc {
        argv_offsets.push(read_u32(
            argv_offsets_bytes,
            i * spawn_contract::WIRE_STRING_OFFSET_BYTES,
        )?);
    }
    cursor = argv_offsets_end;

    // Envp offsets table.
    let envp_offsets_size = envc
        .checked_mul(spawn_contract::WIRE_STRING_OFFSET_BYTES)
        .ok_or(Errno::EINVAL)?;
    let envp_offsets_end = cursor.checked_add(envp_offsets_size).ok_or(Errno::EINVAL)?;
    let envp_offsets_bytes = bytes.get(cursor..envp_offsets_end).ok_or(Errno::EINVAL)?;
    let mut envp_offsets: Vec<u32> = Vec::with_capacity(envc);
    for i in 0..envc {
        envp_offsets.push(read_u32(
            envp_offsets_bytes,
            i * spawn_contract::WIRE_STRING_OFFSET_BYTES,
        )?);
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

    // ARG_MAX accounts for the source pointer arrays as well as the string
    // bytes. Four-byte pointers are the smaller supported representation, so
    // this rejects a blob that could not have been valid on either wasm32 or
    // wasm64 while leaving the host's source-width check authoritative.
    let pointer_bytes = argc
        .checked_add(envc)
        .and_then(|count| count.checked_add(2))
        .and_then(|count| count.checked_mul(core::mem::size_of::<u32>()))
        .ok_or(Errno::E2BIG)?;
    if pointer_bytes > spawn_contract::POSIX_ARG_MAX_BYTES {
        return Err(Errno::E2BIG);
    }
    // First measure every referenced string against one incremental budget,
    // then allocate owned values. WHY: decoding first lets thousands of
    // duplicate offsets copy the same multi-megabyte tail tens of gigabytes
    // before ARG_MAX is checked. Since every scan contributes to this budget,
    // adversarial work and eventual allocations are both bounded by ARG_MAX.
    let mut represented_bytes = pointer_bytes;
    let argv_ranges = measure_strings_by_offset(&argv_offsets, strings, &mut represented_bytes)?;
    let envp_ranges = measure_strings_by_offset(&envp_offsets, strings, &mut represented_bytes)?;
    let argv = decode_measured_strings(&argv_ranges, strings);
    let envp = decode_measured_strings(&envp_ranges, strings);

    // Decode action records.
    let mut file_actions: Vec<FileAction> = Vec::with_capacity(n_actions);
    for i in 0..n_actions {
        let base = i * spawn_contract::WIRE_ACTION_RECORD_BYTES;
        let op = read_u32(actions_bytes, base + spawn_contract::WIRE_ACTION_OP_OFFSET)?;
        let fd = read_i32(actions_bytes, base + spawn_contract::WIRE_ACTION_FD_OFFSET)?;
        let newfd = read_i32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_NEWFD_OFFSET,
        )?;
        let path_off = read_u32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET,
        )?;
        let path_len = read_u32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET,
        )?;
        let oflag = read_i32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_OFLAG_OFFSET,
        )?;
        let mode = read_u32(
            actions_bytes,
            base + spawn_contract::WIRE_ACTION_MODE_OFFSET,
        )?;
        let action = match op {
            x if x == fdop::OPEN => FileAction::Open {
                fd,
                path: read_action_path(strings, path_off, path_len)?,
                oflag,
                mode,
            },
            x if x == fdop::CLOSE => FileAction::Close { fd },
            x if x == fdop::DUP2 => FileAction::Dup2 {
                srcfd: fd,
                fd: newfd,
            },
            x if x == fdop::CHDIR => FileAction::Chdir {
                path: read_action_path(strings, path_off, path_len)?,
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

/// Measure NUL-terminated string references without allocating their bytes.
fn measure_strings_by_offset(
    offsets: &[u32],
    strings: &[u8],
    represented_bytes: &mut usize,
) -> Result<Vec<(usize, usize)>, Errno> {
    let mut ranges = Vec::with_capacity(offsets.len());
    for &off in offsets {
        let off = off as usize;
        if off > strings.len() {
            return Err(Errno::EINVAL);
        }
        let tail = &strings[off..];
        let length = tail.iter().position(|&b| b == 0).ok_or(Errno::EINVAL)?;
        *represented_bytes = represented_bytes
            .checked_add(length)
            .and_then(|total| total.checked_add(1))
            .ok_or(Errno::E2BIG)?;
        if *represented_bytes > spawn_contract::POSIX_ARG_MAX_BYTES {
            return Err(Errno::E2BIG);
        }
        ranges.push((off, off + length));
    }
    Ok(ranges)
}

fn decode_measured_strings(ranges: &[(usize, usize)], strings: &[u8]) -> Vec<Vec<u8>> {
    ranges
        .iter()
        .map(|&(start, end)| strings[start..end].to_vec())
        .collect()
}

/// Read one SYS_SPAWN request (the target path and the request blob) out of
/// the caller's memory and validate it the way process startup will consume
/// it: the per-entry transport limit and `ARG_MAX` counted with the caller's
/// pointer width. Nothing here touches process state.
pub fn read_request(
    host: &mut dyn HostIO,
    pid: u32,
    pointer_width: u8,
    path_addr: u64,
    path_len: usize,
    blob_addr: u64,
    blob_len: usize,
) -> Result<(Vec<u8>, ParsedBlob), Errno> {
    if path_len >= platform_limits::PATH_MAX_BYTES {
        return Err(Errno::ENAMETOOLONG);
    }
    if blob_len == 0 {
        return Err(Errno::EINVAL);
    }
    if blob_len > spawn_contract::WIRE_MAX_BYTES {
        return Err(Errno::E2BIG);
    }
    let pid = pid as i32;
    let mut path =
        crate::guest_ptr::read_guest_bytes(host, pid, path_addr, path_len, platform_limits::PATH_MAX_BYTES)?;
    if path.last() == Some(&0) {
        path.pop();
    }
    let blob = crate::guest_ptr::read_guest_bytes(
        host,
        pid,
        blob_addr,
        blob_len,
        spawn_contract::WIRE_MAX_BYTES,
    )?;
    let parsed = parse_blob(&blob)?;
    if parsed.argv.len() > platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT
        || parsed.envp.len() > platform_limits::PROCESS_STARTUP_MAX_ENVP_COUNT
    {
        return Err(Errno::E2BIG);
    }
    let width = usize::from(pointer_width);
    let mut total = 2 * width;
    for entry in parsed.argv.iter().chain(parsed.envp.iter()) {
        if entry.len() > platform_limits::PROCESS_METADATA_ENTRY_MAX_BYTES {
            return Err(Errno::E2BIG);
        }
        total += width + entry.len() + 1;
        if total > platform_limits::ARG_MAX_BYTES {
            return Err(Errno::E2BIG);
        }
    }
    Ok((path, parsed))
}

#[cfg(test)]
mod parser_tests {
    use super::*;

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
    fn parse_blob_round_trips_the_complete_sortix_file_action_surface_in_order() {
        fn append_action(
            blob: &mut Vec<u8>,
            op: u32,
            fd: i32,
            newfd: i32,
            path_off: u32,
            path_len: u32,
            oflag: i32,
            mode: u32,
        ) {
            let mut record = [0u8; spawn_contract::WIRE_ACTION_RECORD_BYTES];
            record
                [spawn_contract::WIRE_ACTION_OP_OFFSET..spawn_contract::WIRE_ACTION_OP_OFFSET + 4]
                .copy_from_slice(&op.to_le_bytes());
            record
                [spawn_contract::WIRE_ACTION_FD_OFFSET..spawn_contract::WIRE_ACTION_FD_OFFSET + 4]
                .copy_from_slice(&fd.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_NEWFD_OFFSET
                ..spawn_contract::WIRE_ACTION_NEWFD_OFFSET + 4]
                .copy_from_slice(&newfd.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET
                ..spawn_contract::WIRE_ACTION_PATH_OFF_OFFSET + 4]
                .copy_from_slice(&path_off.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET
                ..spawn_contract::WIRE_ACTION_PATH_LEN_OFFSET + 4]
                .copy_from_slice(&path_len.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_OFLAG_OFFSET
                ..spawn_contract::WIRE_ACTION_OFLAG_OFFSET + 4]
                .copy_from_slice(&oflag.to_le_bytes());
            record[spawn_contract::WIRE_ACTION_MODE_OFFSET
                ..spawn_contract::WIRE_ACTION_MODE_OFFSET + 4]
                .copy_from_slice(&mode.to_le_bytes());
            blob.extend_from_slice(&record);
        }

        let all_attr_bits = spawn_contract::ATTR_RESETIDS
            | spawn_contract::ATTR_SETPGROUP
            | spawn_contract::ATTR_SETSIGDEF
            | spawn_contract::ATTR_SETSIGMASK
            | spawn_contract::ATTR_SETSCHEDPARAM
            | spawn_contract::ATTR_SETSCHEDULER
            | spawn_contract::ATTR_USEVFORK
            | spawn_contract::ATTR_SETSID;
        let mut blob = header(0, 0, 5);
        blob[spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET
            ..spawn_contract::WIRE_HEADER_ATTR_FLAGS_OFFSET + 4]
            .copy_from_slice(&all_attr_bits.to_le_bytes());
        blob[spawn_contract::WIRE_HEADER_PGRP_OFFSET..spawn_contract::WIRE_HEADER_PGRP_OFFSET + 4]
            .copy_from_slice(&(-17i32).to_le_bytes());
        blob[spawn_contract::WIRE_HEADER_SIGDEF_OFFSET
            ..spawn_contract::WIRE_HEADER_SIGDEF_OFFSET + 8]
            .copy_from_slice(&0x0102_0304_0506_0708u64.to_le_bytes());
        blob[spawn_contract::WIRE_HEADER_SIGMASK_OFFSET
            ..spawn_contract::WIRE_HEADER_SIGMASK_OFFSET + 8]
            .copy_from_slice(&0x8877_6655_4433_2211u64.to_le_bytes());

        append_action(&mut blob, fdop::OPEN, 3, 0, 0, 12, 0x1234, 0o640);
        append_action(&mut blob, fdop::CLOSE, 4, 0, 0, 0, 0, 0);
        append_action(&mut blob, fdop::DUP2, 5, 6, 0, 0, 0, 0);
        append_action(&mut blob, fdop::CHDIR, 0, 0, 12, 7, 0, 0);
        append_action(&mut blob, fdop::FCHDIR, 7, 0, 0, 0, 0, 0);
        blob.extend_from_slice(b"open-target\0subdir\0");

        let parsed = parse_blob(&blob).expect("complete action surface");
        assert_eq!(parsed.attrs.flags, all_attr_bits);
        assert_eq!(parsed.attrs.pgrp, -17);
        assert_eq!(parsed.attrs.sigdef, 0x0102_0304_0506_0708);
        assert_eq!(parsed.attrs.sigmask, 0x8877_6655_4433_2211);
        assert_eq!(parsed.file_actions.len(), 5);

        match &parsed.file_actions[0] {
            FileAction::Open {
                fd,
                path,
                oflag,
                mode,
            } => {
                assert_eq!((*fd, *oflag, *mode), (3, 0x1234, 0o640));
                assert_eq!(path, b"open-target");
            }
            _ => panic!("first action must be Open"),
        }
        assert!(matches!(
            &parsed.file_actions[1],
            FileAction::Close { fd: 4 }
        ));
        assert!(matches!(
            &parsed.file_actions[2],
            FileAction::Dup2 { srcfd: 5, fd: 6 }
        ));
        match &parsed.file_actions[3] {
            FileAction::Chdir { path } => assert_eq!(path, b"subdir"),
            _ => panic!("fourth action must be Chdir"),
        }
        assert!(matches!(
            &parsed.file_actions[4],
            FileAction::Fchdir { fd: 7 }
        ));
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
    fn parse_blob_rejects_unterminated_argv_and_environment_strings() {
        for (argc, envc) in [(1, 0), (0, 1)] {
            let mut blob = header(argc, envc, 0);
            blob.extend_from_slice(&0u32.to_le_bytes());
            blob.extend_from_slice(b"unterminated");
            assert!(
                matches!(parse_blob(&blob), Err(Errno::EINVAL)),
                "argc={argc}, envc={envc}",
            );
        }
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
        blob.extend_from_slice(&[0u8; spawn_contract::WIRE_ACTION_RECORD_BYTES - 4]);
        assert!(matches!(parse_blob(&blob), Err(Errno::EINVAL)));
    }

    #[test]
    fn parse_blob_rejects_argv_overflow() {
        // argc set to a huge value that would multiply-overflow.
        let mut blob: Vec<u8> = Vec::new();
        blob.extend_from_slice(&u32::MAX.to_le_bytes());
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob.extend_from_slice(&0u32.to_le_bytes());
        blob.extend_from_slice(&[0u8; spawn_contract::WIRE_HEADER_BYTES - 12]);
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

    fn action_path_blob(op: u32, path_len: u32, strings: &[u8]) -> Vec<u8> {
        let mut blob = header(0, 0, 1);
        blob.extend_from_slice(&op.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes()); // fd
        blob.extend_from_slice(&0i32.to_le_bytes()); // newfd
        blob.extend_from_slice(&0u32.to_le_bytes()); // path_off
        blob.extend_from_slice(&path_len.to_le_bytes());
        blob.extend_from_slice(&0i32.to_le_bytes()); // oflag
        blob.extend_from_slice(&0u32.to_le_bytes()); // mode
        blob.extend_from_slice(strings);
        blob
    }

    fn exact_count_blob(argc: usize, envc: usize, n_actions: usize) -> Vec<u8> {
        let mut blob = header(argc as u32, envc as u32, n_actions as u32);
        blob.resize(
            spawn_contract::WIRE_HEADER_BYTES
                + (argc + envc) * spawn_contract::WIRE_STRING_OFFSET_BYTES,
            0,
        );
        for _ in 0..n_actions {
            let mut record = [0u8; spawn_contract::WIRE_ACTION_RECORD_BYTES];
            record
                [spawn_contract::WIRE_ACTION_OP_OFFSET..spawn_contract::WIRE_ACTION_OP_OFFSET + 4]
                .copy_from_slice(&fdop::CLOSE.to_le_bytes());
            blob.extend_from_slice(&record);
        }
        if argc + envc > 0 {
            // Every zero offset deliberately shares one empty NUL-terminated
            // string. Offset aliasing is valid and keeps this boundary test
            // focused on count admission rather than allocation volume.
            blob.push(0);
        }
        blob
    }

    #[test]
    fn parse_blob_accepts_each_exact_count_cap() {
        let argv = parse_blob(&exact_count_blob(spawn_contract::MAX_ARGV_COUNT, 0, 0))
            .expect("exact argv cap");
        assert_eq!(argv.argv.len(), spawn_contract::MAX_ARGV_COUNT);

        let envp = parse_blob(&exact_count_blob(0, spawn_contract::MAX_ENVP_COUNT, 0))
            .expect("exact envp cap");
        assert_eq!(envp.envp.len(), spawn_contract::MAX_ENVP_COUNT);

        let actions = parse_blob(&exact_count_blob(0, 0, spawn_contract::MAX_ACTION_COUNT))
            .expect("exact action cap");
        assert_eq!(actions.file_actions.len(), spawn_contract::MAX_ACTION_COUNT,);
    }

    #[test]
    fn parse_blob_accepts_all_exact_count_caps_together_and_rejects_a_truncated_tail() {
        let exact = exact_count_blob(
            spawn_contract::MAX_ARGV_COUNT,
            spawn_contract::MAX_ENVP_COUNT,
            spawn_contract::MAX_ACTION_COUNT,
        );
        let parsed = parse_blob(&exact).expect("all exact count caps");
        assert_eq!(parsed.argv.len(), spawn_contract::MAX_ARGV_COUNT);
        assert_eq!(parsed.envp.len(), spawn_contract::MAX_ENVP_COUNT);
        assert_eq!(parsed.file_actions.len(), spawn_contract::MAX_ACTION_COUNT);

        let mut truncated = exact;
        truncated.pop();
        assert!(matches!(parse_blob(&truncated), Err(Errno::EINVAL)));
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
    fn parse_blob_rejects_duplicate_max_count_offsets_before_copying_the_tail() {
        let argc = spawn_contract::MAX_ARGV_COUNT;
        let mut blob = header(argc as u32, 0, 0);
        blob.extend(core::iter::repeat_n(
            0u8,
            argc * spawn_contract::WIRE_STRING_OFFSET_BYTES,
        ));
        blob.extend(core::iter::repeat_n(
            b'a',
            spawn_contract::POSIX_ARG_MAX_BYTES - 1,
        ));
        blob.push(0);

        // Decoding before aggregate accounting would try to allocate this
        // approximately four-megabyte string once for every argv entry.
        assert!(matches!(parse_blob(&blob), Err(Errno::E2BIG)));
    }

    #[test]
    fn parse_blob_accepts_exact_arg_max_and_rejects_arg_max_plus_one() {
        // One argv pointer, one envp pointer, and both terminators consume
        // sixteen bytes of the minimum wasm32 source representation.
        let string_bytes = spawn_contract::POSIX_ARG_MAX_BYTES - 16;
        let argv_bytes = string_bytes / 2;
        let envp_bytes = string_bytes - argv_bytes;
        let mut exact = header(1, 1, 0);
        exact.extend_from_slice(&0u32.to_le_bytes());
        exact.extend_from_slice(&(argv_bytes as u32).to_le_bytes());
        exact.extend(core::iter::repeat_n(b'a', argv_bytes - 1));
        exact.push(0);
        exact.extend(core::iter::repeat_n(b'b', envp_bytes - 1));
        exact.push(0);
        assert!(parse_blob(&exact).is_ok());

        let mut oversized = exact;
        oversized.insert(oversized.len() - 1, b'a');
        assert!(matches!(parse_blob(&oversized), Err(Errno::E2BIG)));
    }

    #[test]
    fn parse_blob_bounds_action_paths_by_path_max() {
        fn action_blob(op: u32, path_bytes: usize) -> Vec<u8> {
            let mut blob = header(0, 0, 1);
            blob.extend_from_slice(&op.to_le_bytes());
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

        for op in [fdop::OPEN, fdop::CHDIR] {
            assert!(
                parse_blob(&action_blob(op, spawn_contract::POSIX_PATH_MAX_BYTES)).is_ok(),
                "op {op} must accept PATH_MAX bytes including NUL",
            );
            assert!(
                matches!(
                    parse_blob(&action_blob(op, spawn_contract::POSIX_PATH_MAX_BYTES + 1)),
                    Err(Errno::ENAMETOOLONG)
                ),
                "op {op} must reject PATH_MAX+1 bytes including NUL",
            );
        }
    }

    #[test]
    fn parse_blob_action_paths_require_exactly_one_terminal_nul() {
        for op in [fdop::OPEN, fdop::CHDIR] {
            let parsed =
                parse_blob(&action_path_blob(op, 9, b"relative\0")).expect("one terminal NUL");
            let path = match &parsed.file_actions[0] {
                FileAction::Open { path, .. } | FileAction::Chdir { path } => path,
                _ => panic!("expected path-bearing action"),
            };
            assert_eq!(path, b"relative");

            for (case, path_len, strings) in [
                ("zero length", 0, &b"\0"[..]),
                ("missing terminator", 3, &b"abc\0"[..]),
                ("interior NUL", 4, &b"a\0b\0"[..]),
            ] {
                assert!(
                    matches!(
                        parse_blob(&action_path_blob(op, path_len, strings)),
                        Err(Errno::EINVAL)
                    ),
                    "{case} must be rejected for action op {op}",
                );
            }
        }
    }

    #[test]
    fn parse_blob_rejects_whole_blob_limit_plus_one() {
        let blob = alloc::vec![0; spawn_contract::WIRE_MAX_BYTES + 1];
        assert!(matches!(parse_blob(&blob), Err(Errno::E2BIG)));
    }
}
