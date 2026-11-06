//! `/dev/kmsg`: the kernel message ring as a character device with a
//! per-open cursor.
//!
//! `klogctl` ([`crate::klogctl`]) cannot serve two readers at once: action 2
//! consumes through one machine-global cursor and action 3 is a cursorless
//! snapshot. A syslog daemon tailing the ring while a person runs `dmesg`
//! needs each of them to see every record independently, so this device gives
//! every open its own non-destructive cursor.
//!
//! Neither `/dev/kmsg` nor `dmesg` is POSIX, and Kandelo intends no Linux
//! compatibility, so this is a chosen design for a facility POSIX does not
//! describe. Where it resembles another system's kernel-log device the
//! resemblance is a convenience for programs that already read such a device,
//! not a promise to follow it.
//!
//! # The cursor is the open file description's file position
//!
//! The cursor is the `seq` of the next record to return, stored as the OFD's
//! file offset. There is no side table, so `dup` and `fork` share a cursor for
//! the same reason they share any file position, and two separate opens have
//! independent cursors for the same reason two opens of a file do. `lseek` is
//! the only way a program moves the cursor other than reading:
//!
//! | call | cursor |
//! |------|--------|
//! | `lseek(fd, 0, SEEK_SET)` | the oldest surviving record |
//! | `lseek(fd, 0, SEEK_DATA)` | the first record after the last clear |
//! | `lseek(fd, 0, SEEK_END)` | the tail: only records logged from now on |
//!
//! `SEEK_DATA` and `SEEK_SET` name the same record here, because `clear`
//! discards the records themselves rather than hiding them behind a marker.
//! Any other offset, and `SEEK_CUR`, is `EINVAL`: a record number is not
//! something a program may compute.
//!
//! A new open starts at the oldest surviving record, so `cat /dev/kmsg` shows
//! the log from its beginning.
//!
//! # Reading
//!
//! * One `read` returns exactly one record, never a fragment and never two.
//! * A buffer too small for the next record is `EINVAL` and consumes nothing,
//!   so a reader with a short buffer cannot lose data by believing it read
//!   successfully. The longest line is under 4.2 KiB, so an 8 KiB buffer
//!   always suffices.
//! * At the tail the read is `EAGAIN`: the host returns it to an `O_NONBLOCK`
//!   caller and parks a blocking one.
//! * A cursor behind the oldest surviving record means the reader was
//!   overrun. That read is `EPIPE` once and moves the cursor to the oldest
//!   surviving record, so the next read succeeds.
//!
//! # Writing is refused
//!
//! A write is `EACCES`. The ring is strictly kernel-sourced: any program that
//! could append would be able to forge a kernel record. This is a refusal, not
//! an accept-and-discard.
//!
//! # Line format
//!
//! `<pri>,<seq>,<ts_usec>,<flag>;<text>\n` is the committed external
//! contract; the record struct in [`crate::kmsg`] deliberately is not.
//!
//! * `pri` is `facility * 8 + level`, as in [`crate::klogctl`]'s `<pri>`.
//! * `ts_usec` is microseconds since the kernel's first reading of the host's
//!   `CLOCK_MONOTONIC` (see [`crate::kmsg::KmsgRing::rebase`]), so it is
//!   machine-relative and identical across hosts. The ring stores
//!   nanoseconds; the conversion truncates.
//! * `flag` is `-` for a plain record and `t` when the text was truncated at
//!   [`crate::kmsg::KMSG_MAX_TEXT_BYTES`]. `t` is Kandelo's own choice for a
//!   facility POSIX does not describe. Readers are expected to skip the field,
//!   as upstream sysklogd does (it scans forward to the `;`).
//! * The line is newline-delimited, so the text is escaped on the way out:
//!   every control byte (below 0x20, which includes `\n` and NUL), DEL, and
//!   the backslash itself render as `\xNN`. Without this a program that logs
//!   `"a\n7,1,0,-;fake"` would forge a kernel record boundary. Escaping the
//!   backslash too is what keeps the escape unambiguous: a literal `\x0a` in
//!   the text renders as `\x5cx0a`, distinct from an escaped newline. The C
//!   style `\xNN` is also the form sysklogd's `kmsg_unescape` decodes. That
//!   is the one consumer checked; it does not establish what other
//!   `/dev/kmsg` readers require, nor that sysklogd would reject another
//!   encoding. The escaping is kept because it also keeps a record boundary
//!   unforgeable, which does not depend on any consumer.
//! * `seq` is monotonic and never reused, including across `clear`
//!   ([`crate::kmsg::KmsgRing::clear`] moves `oldest_seq` up and never rewinds
//!   the counter). Consumers deduplicate on it: sysklogd skips any record
//!   whose `seq` is at or below the last one it saw, so a counter that reset
//!   would silently drop every record until it climbed back past that mark.

extern crate alloc;

use wasm_posix_shared::Errno;

use crate::klogctl::syslog_pri;
use crate::kmsg::{format_decimal, KmsgRecordRef, KmsgRing, KMSG_FLAG_TRUNCATED, U64_DECIMAL_DIGITS};
use crate::ofd::OpenFileDesc;

/// `lseek` whence for "the first data after the last clear". Linux's value,
/// which musl's `<unistd.h>` also uses.
pub(crate) const SEEK_DATA: u32 = 3;

/// Longest rendered line, in bytes: `pri` (4 digits), `seq` and `ts_usec` (20
/// digits each), four separators, the flag, a full-length text with every
/// byte escaped to four, and the newline. A buffer this large always holds the
/// next record.
#[cfg(test)]
const MAX_LINE_BYTES: usize = 4 + 20 + 20 + 5 + 1 + 4 * crate::kmsg::KMSG_MAX_TEXT_BYTES + 1;

/// Whether a text byte must be escaped to keep the line's framing intact.
fn needs_escape(byte: u8) -> bool {
    byte < 0x20 || byte == 0x7f || byte == b'\\'
}

/// Walk the rendered line for `rec` as a sequence of byte runs.
///
/// Measuring and rendering share this one description of the line, so they
/// cannot disagree about its length.
fn emit_line(rec: &KmsgRecordRef<'_>, mut put: impl FnMut(&[u8])) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut digits = [0u8; U64_DECIMAL_DIGITS];
    put(format_decimal(u64::from(syslog_pri(rec)), &mut digits));
    put(b",");
    put(format_decimal(rec.seq, &mut digits));
    put(b",");
    // The ring stores nanoseconds; the line carries microseconds.
    put(format_decimal(rec.ts_nsec / 1000, &mut digits));
    put(b",");
    put(if rec.flags & KMSG_FLAG_TRUNCATED != 0 { b"t" } else { b"-" });
    put(b";");
    let mut run_start = 0;
    for (index, &byte) in rec.text.iter().enumerate() {
        if needs_escape(byte) {
            put(&rec.text[run_start..index]);
            put(&[b'\\', b'x', HEX[usize::from(byte >> 4)], HEX[usize::from(byte & 0xf)]]);
            run_start = index + 1;
        }
    }
    put(&rec.text[run_start..]);
    put(b"\n");
}

/// Render one record as a `/dev/kmsg` line into `out`, returning its length.
///
/// `EINVAL` when `out` cannot hold the whole line: a record is delivered
/// whole or not at all, and nothing is written in the failing case.
pub fn kmsg_render_line(rec: &KmsgRecordRef<'_>, out: &mut [u8]) -> Result<usize, Errno> {
    let mut needed = 0;
    emit_line(rec, |part| needed += part.len());
    if needed > out.len() {
        return Err(Errno::EINVAL);
    }
    let mut written = 0;
    emit_line(rec, |part| {
        out[written..written + part.len()].copy_from_slice(part);
        written += part.len();
    });
    Ok(written)
}

/// Read the record at `*cursor` into `out` and advance past it.
///
/// An overrun (`EPIPE`) still moves the cursor, to the oldest surviving
/// record, so the error is reported once. `EAGAIN` and `EINVAL` leave it where
/// it was.
pub(crate) fn read_record(
    ring: &KmsgRing,
    cursor: &mut u64,
    out: &mut [u8],
) -> Result<usize, Errno> {
    if *cursor < ring.oldest_seq() {
        *cursor = ring.oldest_seq();
        return Err(Errno::EPIPE);
    }
    // `EAGAIN` here is the tail: `read_at` only reports `EPIPE` below the
    // oldest record, which was just ruled out.
    let written = kmsg_render_line(&ring.read_at(*cursor)?, out)?;
    *cursor += 1;
    Ok(written)
}

/// The cursor an `lseek` reaches. Only offset 0 with `SEEK_SET`, `SEEK_DATA`
/// or `SEEK_END` is meaningful; see the module documentation.
pub(crate) fn seek(ring: &KmsgRing, whence: u32, offset: i64) -> Result<u64, Errno> {
    use wasm_posix_shared::seek::{SEEK_END, SEEK_SET};
    if offset != 0 {
        return Err(Errno::EINVAL);
    }
    match whence {
        // `clear` discards records, so the oldest survivor is also the first
        // record after the last clear.
        SEEK_SET | SEEK_DATA => Ok(ring.oldest_seq()),
        SEEK_END => Ok(ring.head_seq()),
        _ => Err(Errno::EINVAL),
    }
}

/// The OFD's cursor: its file position as a record number.
fn cursor_of(ofd: &OpenFileDesc) -> u64 {
    u64::try_from(ofd.offset()).unwrap_or(0)
}

/// Point a freshly opened description at the oldest surviving record.
///
/// A new open begins at file position 0, which after the ring has wrapped is
/// an evicted record: the reader's first read would be an `EPIPE` for data it
/// never had a chance to read.
pub(crate) fn start_at_oldest(ofd: &OpenFileDesc) {
    // SAFETY: the kernel services one syscall at a time.
    let oldest = unsafe { crate::kmsg::global_kmsg_ring() }.oldest_seq();
    ofd.set_offset(i64::try_from(oldest).unwrap_or(i64::MAX));
}

/// `read(2)` on an open `/dev/kmsg`: one record at the OFD's cursor.
pub(crate) fn read(ofd: &OpenFileDesc, out: &mut [u8]) -> Result<usize, Errno> {
    // SAFETY: the kernel services one syscall at a time.
    let ring = unsafe { crate::kmsg::global_kmsg_ring() };
    let mut cursor = cursor_of(ofd);
    let result = read_record(ring, &mut cursor, out);
    // Written back on every outcome: an overrun moves the cursor and the
    // others leave it where it was.
    ofd.set_offset(i64::try_from(cursor).unwrap_or(i64::MAX));
    result
}

/// Whether a `read` would return something other than `EAGAIN`: a record, or
/// the overrun report.
pub(crate) fn readable(ofd: &OpenFileDesc) -> bool {
    // SAFETY: the kernel services one syscall at a time.
    cursor_of(ofd) < unsafe { crate::kmsg::global_kmsg_ring() }.head_seq()
}

/// Serializes the tests that touch the machine-global ring.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::boxed::Box;
    use alloc::format;
    use alloc::vec::Vec;

    fn ring() -> Box<KmsgRing> {
        Box::new(KmsgRing::new())
    }

    fn line(ring: &KmsgRing, seq: u64) -> Vec<u8> {
        let mut out = alloc::vec![0u8; 8192];
        let n = kmsg_render_line(&ring.read_at(seq).unwrap(), &mut out).unwrap();
        out.truncate(n);
        out
    }

    #[test]
    fn timestamps_render_as_microseconds_from_nanosecond_storage() {
        let mut ring = ring();
        // 1_234_567_890 ns is 1_234_567.89 us: the rendered value truncates
        // and is plainly not the stored nanosecond count.
        let seq = ring.push(0, 6, 1_234_567_890, b"boot");
        assert_eq!(line(&ring, seq), b"6,0,1234567,-;boot\n");
        // Under a microsecond is zero, not rounded up.
        let seq = ring.push(0, 6, 999, b"early");
        assert_eq!(line(&ring, seq), b"6,1,0,-;early\n");
        // pri is facility * 8 + level, and a truncated record says so.
        let long = alloc::vec![b'x'; crate::kmsg::KMSG_MAX_TEXT_BYTES + 5];
        let seq = ring.push(1, 4, 2_000, &long);
        let rendered = line(&ring, seq);
        assert!(rendered.starts_with(b"12,2,2,t;xxx"), "{:?}", &rendered[..16]);
        assert_eq!(rendered.len(), b"12,2,2,t;".len() + crate::kmsg::KMSG_MAX_TEXT_BYTES + 1);
    }

    #[test]
    fn embedded_newline_and_nul_are_escaped_not_emitted_raw() {
        let mut ring = ring();
        // A program that controls logged text must not be able to end the
        // line and start a record of its own.
        let seq = ring.push(0, 6, 0, b"a\n7,1,0,-;fake");
        let rendered = line(&ring, seq);
        assert_eq!(rendered, b"6,0,0,-;a\\x0a7,1,0,-;fake\n");
        assert_eq!(rendered.iter().filter(|&&b| b == b'\n').count(), 1);

        let seq = ring.push(0, 6, 0, b"b\0c\x1b\x7f");
        let rendered = line(&ring, seq);
        assert_eq!(rendered, b"6,1,0,-;b\\x00c\\x1b\\x7f\n");
        assert!(!rendered.contains(&0));

        // Escaping the backslash keeps a literal `\x0a` distinguishable from
        // an escaped newline.
        let seq = ring.push(0, 6, 0, b"\\x0a");
        assert_eq!(line(&ring, seq), b"6,2,0,-;\\x5cx0a\n");
        // Bytes outside ASCII pass through, so UTF-8 text stays readable.
        let seq = ring.push(0, 6, 0, "caf\u{e9}".as_bytes());
        assert_eq!(line(&ring, seq), "6,3,0,-;caf\u{e9}\n".as_bytes());
    }

    #[test]
    fn the_longest_possible_line_fits_the_documented_buffer() {
        let mut ring = ring();
        // Every byte escapes to four, the text is truncated at its cap, and
        // the numbers are as wide as they get.
        let worst = alloc::vec![0u8; crate::kmsg::KMSG_MAX_TEXT_BYTES + 1];
        let seq = ring.push(255, 7, u64::MAX, &worst);
        let record = ring.read_at(seq).unwrap();
        let usec = format!("{}", u64::MAX / 1000);
        let expected = format!("2047,{seq},{usec},t;").len()
            + 4 * crate::kmsg::KMSG_MAX_TEXT_BYTES
            + 1;
        assert!(expected <= MAX_LINE_BYTES && MAX_LINE_BYTES < 8 * 1024);

        let mut out = alloc::vec![0u8; MAX_LINE_BYTES];
        assert_eq!(kmsg_render_line(&record, &mut out), Ok(expected));
        assert_eq!(
            kmsg_render_line(&record, &mut out[..expected - 1]),
            Err(Errno::EINVAL),
            "the length is exact, not rounded up"
        );
    }

    #[test]
    fn buffer_smaller_than_the_next_record_returns_einval() {
        let mut ring = ring();
        let first = ring.push(0, 6, 1_000, b"hello");
        ring.push(0, 6, 2_000, b"world");
        let expected = b"6,0,1,-;hello\n";
        let mut cursor = first;

        // One byte short is refused, never truncated, and consumes nothing.
        let mut short = alloc::vec![0xAAu8; expected.len() - 1];
        assert_eq!(read_record(&ring, &mut cursor, &mut short), Err(Errno::EINVAL));
        assert_eq!(cursor, first, "the record must still be there to read");
        assert!(short.iter().all(|&b| b == 0xAA), "nothing partial is written");

        // The same record is delivered whole once the buffer is big enough.
        let mut exact = alloc::vec![0u8; expected.len()];
        assert_eq!(read_record(&ring, &mut cursor, &mut exact), Ok(expected.len()));
        assert_eq!(exact, expected);
        assert_eq!(cursor, first + 1);

        // A buffer with room for the next record and part of a third never
        // returns two: one read is one record.
        let mut roomy = alloc::vec![0u8; 4096];
        assert_eq!(read_record(&ring, &mut cursor, &mut roomy), Ok(b"6,1,2,-;world\n".len()));
    }

    #[test]
    fn cursor_exactly_at_the_eviction_boundary_yields_one_epipe_then_oldest() {
        let mut ring = ring();
        let mut out = alloc::vec![0u8; 4096];
        let text = [b'x'; 100];
        ring.push(0, 6, 0, &text);
        assert_eq!(ring.oldest_seq(), 0);
        // A reader positioned at the oldest record, which has not been read.
        let mut cursor = 0;

        // Wrap until the reader's record is gone, and stop at the first push
        // that evicts it so the cursor sits exactly on the boundary.
        while ring.oldest_seq() == 0 {
            ring.push(0, 6, 0, &text);
        }
        let oldest = ring.oldest_seq();
        // Exactly the reader's record (seq 0) was evicted, no more, so the
        // cursor sits on the newest evicted seq: the boundary itself.
        assert_eq!(oldest, 1, "exactly the reader's record was evicted, no more");

        // Exactly one EPIPE...
        assert_eq!(read_record(&ring, &mut cursor, &mut out), Err(Errno::EPIPE));
        assert_eq!(cursor, oldest, "the cursor resumes at the oldest survivor");
        // ...then the oldest surviving record, and never EPIPE again.
        let n = read_record(&ring, &mut cursor, &mut out).unwrap();
        let expected_head = format!("6,{oldest},0,-;");
        assert!(out[..n].starts_with(expected_head.as_bytes()));
        assert_eq!(cursor, oldest + 1);
        assert_ne!(read_record(&ring, &mut cursor, &mut out), Err(Errno::EPIPE));

        // A cursor ON the oldest record was not overrun and is not told so.
        let mut at_oldest = oldest;
        assert!(read_record(&ring, &mut at_oldest, &mut out).is_ok());

        // Draining to the tail is EAGAIN: wait, not end-of-file and not
        // overrun, however long the reader has been away.
        let mut tail = ring.head_seq();
        assert_eq!(read_record(&ring, &mut tail, &mut out), Err(Errno::EAGAIN));
    }

    #[test]
    fn a_cleared_ring_overruns_a_cursor_once_then_waits() {
        let mut ring = ring();
        let mut out = alloc::vec![0u8; 4096];
        ring.push(0, 6, 0, b"gone");
        let mut cursor = 0;
        ring.clear();
        assert_eq!(read_record(&ring, &mut cursor, &mut out), Err(Errno::EPIPE));
        assert_eq!(cursor, ring.head_seq());
        assert_eq!(read_record(&ring, &mut cursor, &mut out), Err(Errno::EAGAIN));
        ring.push(0, 6, 0, b"new");
        let n = read_record(&ring, &mut cursor, &mut out).unwrap();
        assert_eq!(&out[..n], b"6,1,0,-;new\n");
    }

    #[test]
    fn seek_reaches_oldest_data_and_tail_and_nothing_else() {
        let mut ring = ring();
        ring.push(0, 6, 0, b"a");
        ring.push(0, 6, 0, b"b");
        assert_eq!(seek(&ring, 0, 0), Ok(0));
        assert_eq!(seek(&ring, 2, 0), Ok(2));
        ring.clear();
        ring.push(0, 6, 0, b"c");
        assert_eq!(seek(&ring, 0, 0), Ok(2));
        assert_eq!(seek(&ring, SEEK_DATA, 0), Ok(2));
        assert_eq!(seek(&ring, 2, 0), Ok(3));
        // A record number is not something a program may compute.
        assert_eq!(seek(&ring, 0, 1), Err(Errno::EINVAL));
        assert_eq!(seek(&ring, 0, -1), Err(Errno::EINVAL));
        assert_eq!(seek(&ring, 2, -1), Err(Errno::EINVAL));
        assert_eq!(seek(&ring, 1, 0), Err(Errno::EINVAL), "SEEK_CUR");
        assert_eq!(seek(&ring, 99, 0), Err(Errno::EINVAL));
    }
}
