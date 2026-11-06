//! `klogctl` (`SYS_SYSLOG`, Kandelo syscall 304): the syscall surface over the
//! kernel message ring in [`crate::kmsg`].
//!
//! The ring's storage lives in `kmsg.rs`; this module owns the action table,
//! the rendered byte stream, and the machine-global read cursor.

extern crate alloc;

use wasm_posix_shared::Errno;

use crate::kmsg::{KmsgRecordRef, KmsgRing};

// ---------------------------------------------------------------------------
// klogctl (`SYS_SYSLOG`, Kandelo syscall 304)
//
// Kandelo is not Linux and intends no Linux compatibility. Neither `dmesg`
// nor `klogctl` is POSIX, so there is no conformance target here, only a
// design: this is the read surface `dmesg -S` uses, chosen because a byte
// stream with no descriptor is the cheapest way to let a program ask the
// machine what the kernel has recorded. `/dev/kmsg` is the richer surface.
//
// The committed contract is the rendered byte stream, not the ring's storage
// layout: one line per record, `<pri>` followed by the text and a newline,
// where `pri = facility * 8 + level` (see `crate::kmsg`).
//
// Access posture: reads are unrestricted, because a Kandelo machine has no
// multi-tenant threat model and gating reads behind root would make `dmesg`
// useless to the people who most need it. Clearing requires root because it
// destroys state shared with every other reader.
// ---------------------------------------------------------------------------

/// Read the records after the shared cursor, advancing it past them.
const SYSLOG_ACTION_READ: i32 = 2;
/// Read every live record without consuming anything.
const SYSLOG_ACTION_READ_ALL: i32 = 3;
/// Read every live record, then discard the ring. Root only.
const SYSLOG_ACTION_READ_CLEAR: i32 = 4;
/// Discard every live record. Root only.
const SYSLOG_ACTION_CLEAR: i32 = 5;
/// Refused: Kandelo has no console log level to turn off.
const SYSLOG_ACTION_CONSOLE_OFF: i32 = 6;
/// Refused: Kandelo has no console log level to turn on.
const SYSLOG_ACTION_CONSOLE_ON: i32 = 7;
/// Refused: Kandelo has no console log level to set.
const SYSLOG_ACTION_CONSOLE_LEVEL: i32 = 8;
/// Rendered bytes waiting after the shared cursor.
const SYSLOG_ACTION_SIZE_UNREAD: i32 = 9;
/// The ring's total capacity in bytes.
const SYSLOG_ACTION_SIZE_BUFFER: i32 = 10;

/// Widest `<pri>` prefix: facility 255 with level 7 renders `<2047>`.
const SYSLOG_PRI_MAX_DIGITS: usize = 4;

/// Machine-global `klogctl` read cursor: the `seq` [`SYSLOG_ACTION_READ`]
/// returns next.
///
/// `klogctl` takes no file descriptor, so there is nothing per-caller to hang
/// a cursor on and every `READ` caller necessarily shares this one. A reader
/// that wants its own cursor opens `/dev/kmsg`.
struct GlobalSyslogCursor(core::cell::UnsafeCell<u64>);

/// SAFETY: access is serialized — the kernel services one syscall at a time.
unsafe impl Sync for GlobalSyslogCursor {}

static SYSLOG_CURSOR: GlobalSyslogCursor = GlobalSyslogCursor(core::cell::UnsafeCell::new(0));

/// `klogctl`: read or discard kernel log records. Returns bytes copied for the
/// read actions, a byte count for the size actions, and 0 for a bare clear.
pub(crate) fn sys_klogctl(action: i32, buf: Option<&mut [u8]>, uid: u32) -> Result<i32, Errno> {
    // SAFETY: the kernel services one syscall at a time, so no other
    // reference to the ring or to the cursor can exist here.
    unsafe {
        syslog_action(
            crate::kmsg::global_kmsg_ring(),
            &mut *SYSLOG_CURSOR.0.get(),
            action,
            buf,
            uid,
        )
    }
}

/// The `klogctl` action table, over an explicit ring and cursor so it is
/// testable without the machine-global state.
fn syslog_action(
    ring: &mut KmsgRing,
    cursor: &mut u64,
    action: i32,
    buf: Option<&mut [u8]>,
    uid: u32,
) -> Result<i32, Errno> {
    match action {
        SYSLOG_ACTION_READ => {
            let out = buf.ok_or(Errno::EINVAL)?;
            // A cursor left behind by eviction or a clear resumes at the
            // oldest surviving record rather than reading freed storage.
            let first = (*cursor).max(ring.oldest_seq());
            let (written, next) = syslog_copy_forward(ring, first, out);
            *cursor = next;
            syslog_count(written)
        }
        SYSLOG_ACTION_READ_ALL => {
            let out = buf.ok_or(Errno::EINVAL)?;
            syslog_count(syslog_read_all(ring, out))
        }
        SYSLOG_ACTION_READ_CLEAR => {
            if uid != 0 {
                return Err(Errno::EPERM);
            }
            let out = buf.ok_or(Errno::EINVAL)?;
            let written = syslog_read_all(ring, out);
            ring.clear();
            syslog_count(written)
        }
        SYSLOG_ACTION_CLEAR => {
            // Authority first, request shape second: a caller without the
            // privilege to clear must hear `EPERM` whatever else it got
            // wrong, or the refusal it sees depends on an unrelated mistake.
            if uid != 0 {
                return Err(Errno::EPERM);
            }
            syslog_reject_output_buffer(buf)?;
            ring.clear();
            Ok(0)
        }
        // Pairs with `SYSLOG_ACTION_READ`, not `READ_ALL`: it counts what is
        // left after the shared cursor, which is exactly what the next `READ`
        // will hand back. `READ_ALL` ignores the cursor and returns every live
        // record, so it is always at least this large and usually larger —
        // size a `READ_ALL` buffer from `SIZE_BUFFER` instead. Reading this as
        // "bytes a `READ_ALL` would return" silently loses the oldest records,
        // which is a mistake worth naming here because it is easy to make.
        SYSLOG_ACTION_SIZE_UNREAD => {
            syslog_reject_output_buffer(buf)?;
            syslog_count(syslog_unread_rendered_bytes(ring, *cursor))
        }
        SYSLOG_ACTION_SIZE_BUFFER => {
            syslog_reject_output_buffer(buf)?;
            syslog_count(crate::kmsg::KMSG_CAPACITY_BYTES)
        }
        // 6, 7 and 8 ask for a console log level Kandelo does not have, and
        // every other action is one this kernel does not implement. Both are
        // refused rather than reported as success.
        _ => Err(Errno::EINVAL),
    }
}

/// Narrow a byte count to the `int` a `klogctl` caller receives.
fn syslog_count(bytes: usize) -> Result<i32, Errno> {
    i32::try_from(bytes).map_err(|_| Errno::EINVAL)
}

/// Refuse a buffer handed to an action that writes nothing into one.
///
/// The counting and clearing actions return a count, not a transfer length:
/// `SIZE_BUFFER` reports the whole ring however small the caller's buffer is.
/// The syscall channel reads a successful result as the number of bytes the
/// kernel wrote into the staged buffer, so lending one here would make the
/// result describe bytes that were never written. Refusing says that plainly
/// instead of leaving the channel to reject it as a protocol failure, and it
/// keeps one invariant true: a non-empty buffer only ever reaches an action
/// that writes into it.
///
/// An empty buffer is fine. A caller passing `NULL` and a zero length — the
/// ordinary way to invoke these actions — is indistinguishable from one
/// passing an empty borrow, because the channel canonicalizes both to the
/// start of its scratch allocation.
fn syslog_reject_output_buffer(buf: Option<&mut [u8]>) -> Result<(), Errno> {
    match buf {
        Some(out) if !out.is_empty() => Err(Errno::EINVAL),
        _ => Ok(()),
    }
}

/// Copy the newest whole records that fit in `out`, oldest of those first.
///
/// A reader whose buffer cannot hold the whole log wants its tail: the newest
/// records are the ones that explain what just happened.
fn syslog_read_all(ring: &KmsgRing, out: &mut [u8]) -> usize {
    syslog_copy_forward(ring, syslog_tail_start(ring, out.len()), out).0
}

/// The oldest `seq` whose records, through the newest, all fit in `len` bytes.
///
/// When not even the newest record fits, that record is still selected, so a
/// short buffer yields a truncated newest record rather than nothing.
fn syslog_tail_start(ring: &KmsgRing, len: usize) -> u64 {
    let head = ring.head_seq();
    let mut seq = head;
    let mut total = 0;
    while seq > ring.oldest_seq() {
        let Ok(record) = ring.read_at(seq - 1) else {
            break;
        };
        let size = syslog_rendered_len(&record);
        if total + size > len {
            if seq == head {
                seq -= 1;
            }
            break;
        }
        total += size;
        seq -= 1;
    }
    seq
}

/// Render records from `first` forward into `out`, stopping at the first one
/// that does not fit. Returns the bytes written and the `seq` to resume at.
///
/// When the very first record does not fit it is written truncated and skipped
/// anyway: a reader must always make progress, or it loops forever on a
/// zero-byte result. An empty `out` is the exception — it copies nothing and
/// consumes nothing, so a zero-length request cannot silently drop a record.
fn syslog_copy_forward(ring: &KmsgRing, first: u64, out: &mut [u8]) -> (usize, u64) {
    let mut written = 0;
    let mut seq = first;
    while seq < ring.head_seq() {
        let Ok(record) = ring.read_at(seq) else {
            break;
        };
        if written + syslog_rendered_len(&record) > out.len() {
            if written > 0 || out.is_empty() {
                break;
            }
            written = syslog_render(&record, out);
            seq += 1;
            break;
        }
        written += syslog_render(&record, &mut out[written..]);
        seq += 1;
    }
    (written, seq)
}

/// Rendered bytes of the live records at or after `cursor`.
///
/// A caller sizes its buffer from this and then reads, so it counts rendered
/// bytes rather than the ring's stored header-plus-text bytes: reporting the
/// stored count would under-size the buffer and lose records.
fn syslog_unread_rendered_bytes(ring: &KmsgRing, cursor: u64) -> usize {
    let mut total = 0;
    let mut seq = cursor.max(ring.oldest_seq());
    while seq < ring.head_seq() {
        let Ok(record) = ring.read_at(seq) else {
            break;
        };
        total += syslog_rendered_len(&record);
        seq += 1;
    }
    total
}

/// Bytes one record occupies in the rendered stream: `<pri>`, text, newline.
fn syslog_rendered_len(record: &KmsgRecordRef<'_>) -> usize {
    syslog_pri_digits(syslog_pri(record)) + 2 + record.text.len() + 1
}

/// RFC 5424 priority: `facility * 8 + level`.
fn syslog_pri(record: &KmsgRecordRef<'_>) -> u32 {
    u32::from(record.facility) * 8 + u32::from(record.level)
}

fn syslog_pri_digits(pri: u32) -> usize {
    match pri {
        0..=9 => 1,
        10..=99 => 2,
        100..=999 => 3,
        _ => 4,
    }
}

/// Render `<pri>text\n` into `out`, writing only what fits. Returns the bytes
/// written, which is [`syslog_rendered_len`] unless `out` was too small.
fn syslog_render(record: &KmsgRecordRef<'_>, out: &mut [u8]) -> usize {
    let mut prefix = [0u8; SYSLOG_PRI_MAX_DIGITS + 2];
    let mut pri = syslog_pri(record);
    let digits = syslog_pri_digits(pri);
    prefix[0] = b'<';
    for offset in (1..=digits).rev() {
        prefix[offset] = b'0' + (pri % 10) as u8;
        pri /= 10;
    }
    prefix[digits + 1] = b'>';

    let mut written = 0;
    for part in [&prefix[..digits + 2], record.text, &b"\n"[..]] {
        let room = out.len() - written;
        if room == 0 {
            break;
        }
        let take = part.len().min(room);
        out[written..written + take].copy_from_slice(&part[..take]);
        written += take;
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;
    use crate::kmsg::{KmsgRing, KMSG_CAPACITY_BYTES};
    use alloc::boxed::Box;

    const ROOT: u32 = 0;
    const USER: u32 = 1000;

    /// The ring is 128 KiB, so keep it off the test thread's stack.
    fn ring() -> Box<KmsgRing> {
        Box::new(KmsgRing::new())
    }

    /// A buffer larger than anything these tests push.
    fn buffer() -> Vec<u8> {
        alloc::vec![0u8; 4096]
    }

    #[test]
    fn action_3_read_all_returns_every_live_record_with_pri_prefixes() {
        let mut ring = ring();
        ring.push(0, 6, 1, b"boot: hello");
        ring.push(0, 3, 2, b"enosys: syscall 999 not implemented");
        ring.push(1, 4, 3, b"a user-facility warning");
        let mut cursor = 0;
        let mut out = buffer();
        let read = syslog_action(
            &mut ring,
            &mut cursor,
            SYSLOG_ACTION_READ_ALL,
            Some(&mut out),
            USER,
        )
        .unwrap();
        // pri = facility * 8 + level, so LOG_KERN/LOG_INFO is 6 and
        // LOG_USER/LOG_WARNING is 12.
        let mut expected = Vec::new();
        expected.extend_from_slice(b"<6>boot: hello\n");
        expected.extend_from_slice(b"<3>enosys: syscall 999 not implemented\n");
        expected.extend_from_slice(b"<12>a user-facility warning\n");
        assert_eq!(&out[..read as usize], expected.as_slice());
        // READ_ALL consumes nothing: the cursor is untouched and a second
        // call returns the same bytes.
        assert_eq!(cursor, 0);
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_ALL,
                Some(&mut out),
                USER
            ),
            Ok(read),
        );
    }

    #[test]
    fn action_9_size_unread_matches_bytes_after_the_cursor() {
        let mut ring = ring();
        ring.push(0, 6, 1, b"one");
        ring.push(0, 6, 2, b"two");
        let mut cursor = 0;
        let unread = |ring: &mut KmsgRing, cursor: &mut u64| {
            syslog_action(ring, cursor, SYSLOG_ACTION_SIZE_UNREAD, None, USER)
        };
        assert_eq!(unread(&mut ring, &mut cursor), Ok(b"<6>one\n<6>two\n".len() as i32));
        // A caller sizes its buffer from SIZE_UNREAD and then READs, so the
        // count must be the RENDERED length, never the stored header-plus-text
        // length — that would under-size the buffer and silently lose records.
        assert!(
            ring.unread_bytes(cursor) > b"<6>one\n<6>two\n".len(),
            "the stored byte count is the one SIZE_UNREAD must not report",
        );

        let mut out = buffer();
        syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_READ, Some(&mut out), USER).unwrap();
        assert_eq!(unread(&mut ring, &mut cursor), Ok(0));

        ring.push(0, 6, 3, b"three");
        assert_eq!(unread(&mut ring, &mut cursor), Ok(b"<6>three\n".len() as i32));
    }

    #[test]
    fn action_10_size_buffer_reports_128_kib() {
        let mut ring = ring();
        let mut cursor = 0;
        assert_eq!(KMSG_CAPACITY_BYTES, 128 * 1024);
        assert_eq!(
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_SIZE_BUFFER, None, USER),
            Ok(KMSG_CAPACITY_BYTES as i32),
        );
    }

    #[test]
    fn action_2_read_consumes_what_it_returns() {
        let mut ring = ring();
        ring.push(0, 6, 1, b"first");
        ring.push(0, 6, 2, b"second");
        let mut cursor = 0;
        let mut out = buffer();
        let read =
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_READ, Some(&mut out), USER).unwrap();
        assert_eq!(&out[..read as usize], b"<6>first\n<6>second\n");
        // What READ returned is gone from the cursor's view.
        assert_eq!(
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_READ, Some(&mut out), USER),
            Ok(0),
        );
        // The records themselves survive: READ moves a cursor, it does not
        // destroy the ring.
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_ALL,
                Some(&mut out),
                USER
            ),
            Ok(read),
        );
        ring.push(0, 6, 3, b"third");
        let read =
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_READ, Some(&mut out), USER).unwrap();
        assert_eq!(&out[..read as usize], b"<6>third\n");
    }

    #[test]
    fn actions_4_and_5_require_root() {
        let mut ring = ring();
        ring.push(0, 6, 1, b"kept");
        let mut cursor = 0;
        let mut out = buffer();
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_CLEAR,
                Some(&mut out),
                USER
            ),
            Err(Errno::EPERM),
        );
        assert_eq!(
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_CLEAR, None, USER),
            Err(Errno::EPERM),
        );
        // Authority is decided before request shape, so a non-root caller
        // hears EPERM even when it also passed a buffer the action does not
        // take. Otherwise the refusal a caller sees would depend on an
        // unrelated mistake and hide the one that matters.
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_CLEAR,
                Some(&mut out),
                USER
            ),
            Err(Errno::EPERM),
        );

        // A refused clear destroys nothing, and reads stay unrestricted.
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_ALL,
                Some(&mut out),
                USER
            ),
            Ok(b"<6>kept\n".len() as i32),
        );

        let read = syslog_action(
            &mut ring,
            &mut cursor,
            SYSLOG_ACTION_READ_CLEAR,
            Some(&mut out),
            ROOT,
        )
        .unwrap();
        assert_eq!(&out[..read as usize], b"<6>kept\n");
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_ALL,
                Some(&mut out),
                ROOT
            ),
            Ok(0),
        );

        ring.push(0, 6, 2, b"later");
        assert_eq!(
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_CLEAR, None, ROOT),
            Ok(0),
        );
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_ALL,
                Some(&mut out),
                ROOT
            ),
            Ok(0),
        );
    }

    #[test]
    fn actions_6_7_8_console_level_return_einval() {
        // Kandelo has no console log level, so these are refused outright
        // rather than accepted and ignored.
        let mut ring = ring();
        let mut cursor = 0;
        for action in [
            SYSLOG_ACTION_CONSOLE_OFF,
            SYSLOG_ACTION_CONSOLE_ON,
            SYSLOG_ACTION_CONSOLE_LEVEL,
        ] {
            assert_eq!(
                syslog_action(&mut ring, &mut cursor, action, None, ROOT),
                Err(Errno::EINVAL),
                "action {action}",
            );
        }
    }

    #[test]
    fn unknown_action_returns_einval() {
        let mut ring = ring();
        let mut cursor = 0;
        // 0 and 1 are elsewhere called CLOSE and OPEN. Kandelo keeps no
        // per-caller klogctl state for them to open or close, so they are not
        // in the implemented action table either.
        for action in [i32::MIN, -1, 0, 1, 11, 12, i32::MAX] {
            assert_eq!(
                syslog_action(&mut ring, &mut cursor, action, None, ROOT),
                Err(Errno::EINVAL),
                "action {action}",
            );
        }
    }

    #[test]
    fn syslog_read_actions_refuse_a_missing_buffer() {
        let mut ring = ring();
        ring.push(0, 6, 1, b"something to read");
        let mut cursor = 0;
        for action in [
            SYSLOG_ACTION_READ,
            SYSLOG_ACTION_READ_ALL,
            SYSLOG_ACTION_READ_CLEAR,
        ] {
            assert_eq!(
                syslog_action(&mut ring, &mut cursor, action, None, ROOT),
                Err(Errno::EINVAL),
                "action {action}",
            );
        }
        // The refused READ_CLEAR did not clear the ring.
        let mut out = buffer();
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_ALL,
                Some(&mut out),
                ROOT
            ),
            Ok(b"<6>something to read\n".len() as i32),
        );
    }

    #[test]
    fn size_unread_sizes_a_read_not_a_read_all() {
        // SIZE_UNREAD counts what is left after the shared cursor, so it
        // sizes the next READ exactly. It is NOT the size of a READ_ALL
        // buffer: READ_ALL ignores the cursor and returns every live record,
        // so once a READ has advanced the cursor READ_ALL is strictly larger.
        // Sizing a READ_ALL buffer from SIZE_UNREAD drops the oldest records,
        // which is why this pairing is pinned rather than left to a comment.
        let mut ring = ring();
        ring.push(0, 6, 1, b"one");
        ring.push(0, 6, 2, b"two");
        ring.push(0, 6, 3, b"three");
        let mut cursor = 0;

        let every_record = b"<6>one\n<6>two\n<6>three\n";
        let after_first = b"<6>two\n<6>three\n";

        // Consume exactly the first record, leaving the cursor mid-log.
        let mut one = [0u8; b"<6>one\n".len()];
        assert_eq!(
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_READ, Some(&mut one), USER),
            Ok(one.len() as i32),
        );
        assert_eq!(&one, b"<6>one\n");
        assert_eq!(cursor, 1);

        // SIZE_UNREAD now describes the remainder, not the whole log.
        let unread = syslog_action(
            &mut ring,
            &mut cursor,
            SYSLOG_ACTION_SIZE_UNREAD,
            None,
            USER,
        )
        .unwrap();
        assert_eq!(unread, after_first.len() as i32);

        // READ_ALL is strictly larger: that is the trap this test exists for.
        let mut big = buffer();
        let read_all = syslog_action(
            &mut ring,
            &mut cursor,
            SYSLOG_ACTION_READ_ALL,
            Some(&mut big),
            USER,
        )
        .unwrap();
        assert_eq!(&big[..read_all as usize], every_record.as_slice());
        assert!(
            read_all > unread,
            "READ_ALL ({read_all}) must exceed SIZE_UNREAD ({unread}) once the \
             cursor has moved; sizing a READ_ALL buffer from SIZE_UNREAD would \
             drop the oldest records",
        );

        // A buffer sized from SIZE_UNREAD holds the next READ exactly: no
        // truncation, nothing left behind.
        let mut sized = alloc::vec![0u8; unread as usize];
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ,
                Some(&mut sized),
                USER
            ),
            Ok(unread),
        );
        assert_eq!(sized.as_slice(), after_first.as_slice());
        assert_eq!(
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_SIZE_UNREAD, None, USER),
            Ok(0),
        );
    }

    #[test]
    fn syslog_counting_and_clearing_actions_refuse_a_buffer() {
        // These actions write nothing, so their result is a count and not a
        // transfer length. The syscall channel reads a successful result as
        // the bytes written into the staged buffer, so a buffer here would
        // make the result claim a transfer that never happened.
        let mut ring = ring();
        ring.push(0, 6, 1, b"kept");
        let mut cursor = 0;
        let mut out = buffer();
        for action in [
            SYSLOG_ACTION_SIZE_UNREAD,
            SYSLOG_ACTION_SIZE_BUFFER,
            SYSLOG_ACTION_CLEAR,
        ] {
            assert_eq!(
                syslog_action(&mut ring, &mut cursor, action, Some(&mut out), ROOT),
                Err(Errno::EINVAL),
                "action {action}",
            );
            // An empty borrow is the ordinary invocation and must still work.
            assert!(
                syslog_action(&mut ring, &mut cursor, action, Some(&mut []), ROOT).is_ok(),
                "action {action} with an empty buffer",
            );
            assert!(
                syslog_action(&mut ring, &mut cursor, action, None, ROOT).is_ok(),
                "action {action} with no buffer",
            );
        }
        // The refused calls did not clear the ring; the accepted CLEAR did.
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_ALL,
                Some(&mut out),
                ROOT
            ),
            Ok(0),
        );
    }

    #[test]
    fn syslog_reads_make_progress_on_a_buffer_too_small_for_one_record() {
        let mut ring = ring();
        ring.push(0, 6, 1, b"aaaaaaaaaa");
        ring.push(0, 6, 2, b"bbbbbbbbbb");
        let mut cursor = 0;

        // A zero-length buffer copies nothing and consumes nothing.
        assert_eq!(
            syslog_action(&mut ring, &mut cursor, SYSLOG_ACTION_READ, Some(&mut []), USER),
            Ok(0),
        );
        assert_eq!(cursor, 0);

        // A buffer too small for even one record returns a truncated record
        // and advances past it, so a reader can never loop on a zero result.
        let mut out = [0u8; 5];
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ,
                Some(&mut out),
                USER
            ),
            Ok(5),
        );
        assert_eq!(&out, b"<6>aa");
        assert_eq!(cursor, 1);

        // READ_ALL with a short buffer returns the NEWEST whole records that
        // fit, which is what a truncating reader wants to see.
        let mut out = [0u8; 14];
        assert_eq!(
            syslog_action(
                &mut ring,
                &mut cursor,
                SYSLOG_ACTION_READ_ALL,
                Some(&mut out),
                USER
            ),
            Ok(14),
        );
        assert_eq!(&out, b"<6>bbbbbbbbbb\n");
    }
}
