//! The kernel message ring: a machine-global, fixed-size log of kernel events.
//!
//! One statically allocated byte ring holds header-plus-text records, so
//! steady state allocates nothing. The kernel is a separate Wasm module with
//! its own linear memory, so `fork` and `exec` never touch the ring; it is
//! machine-lifetime state that dies at reboot.
//!
//! The record layout below is kernel-internal and deliberately not `repr(C)`
//! or ABI surface. The committed external contract is the textual
//! `/dev/kmsg` line format and the `syslog(2)` byte stream rendered from
//! these records, so the storage layout may change without an ABI bump.
//!
//! Priorities use the RFC 5424 encoding `pri = facility * 8 + level`; kernel
//! records use facility `LOG_KERN` (0). The ring stores `facility` and `level`
//! separately so a renderer can produce `pri` without a translation step.
//!
//! # Sequence numbers
//!
//! Every record is assigned a `seq` from a counter that only moves forward:
//! eviction by wraparound and `clear` never rewind or reuse it. `oldest_seq`
//! and `head_seq` bracket the live records as the half-open range
//! `oldest_seq..head_seq`; `head_seq` is the `seq` the *next* push will
//! receive, so a reader whose cursor equals `head_seq` is at the tail.
//!
//! # Storage
//!
//! Records are variable length and never straddle the end of the byte ring,
//! because [`KmsgRecordRef::text`] borrows contiguous bytes. A record that
//! would cross the end is written at the start of the ring instead, and the
//! bytes left at the end become a gap: a pad entry (a header with
//! [`PAD_FLAG`] set) when they can hold a header, or nothing at all when they
//! cannot. Pads carry no `seq` and are invisible through the public API.
//!
//! Positions are tracked as monotonically increasing logical byte offsets
//! (`offset = position % KMSG_CAPACITY_BYTES`). `read_at` finds a record by
//! walking from the oldest one, which is `O(live records)`: the ring holds at
//! most `KMSG_CAPACITY_BYTES / KMSG_HEADER_BYTES` records and a typical boot
//! log holds well under two thousand, so no per-record index is kept.
//!
//! # Rate limiting
//!
//! A kernel path that can fire on every syscall (an unimplemented-syscall
//! report, say) must not let one spinning program evict the boot log.
//! [`KmsgRing::push_limited`] admits up to [`KMSG_RATE_BURST`] records per
//! callsite per [`KMSG_RATE_INTERVAL_NSEC`] window and drops the rest. When a
//! window reopens, the next admitted record is preceded by a
//! `N messages suppressed` record so the log states how much it lost. That
//! count record is written with [`KmsgRing::push`], never through the limiter,
//! so a flood degrades to a bounded sample plus an honest count and can never
//! degrade to silence.
//!
//! The kernel has no timer, so the count is reported lazily, by the first
//! record from the same callsite after the window closes. A callsite that
//! floods and then never logs again leaves its final count unreported.

use core::cell::UnsafeCell;
use wasm_posix_shared::Errno;

/// Size of the byte ring: exactly 128 KiB, fixed, not configurable.
///
/// The figure itself lives in `wasm_posix_shared::platform_limits` because
/// `klogctl` reports it to a guest and the host's channel copy-back contract
/// bounds that report against it. One definition keeps the three in step.
pub const KMSG_CAPACITY_BYTES: usize = wasm_posix_shared::platform_limits::KMSG_CAPACITY_BYTES;

/// Longest text one record stores. Longer text is truncated and the record is
/// flagged with [`KMSG_FLAG_TRUNCATED`]. Bounding a record keeps a single
/// message from evicting the boot log, and keeps the rendered line within the
/// buffers `dmesg` and a syslog daemon use.
pub const KMSG_MAX_TEXT_BYTES: usize = 1024;

/// Stored bytes of one record's header, ahead of its text.
pub const KMSG_HEADER_BYTES: usize = 21;

/// Record flag: the text was cut at [`KMSG_MAX_TEXT_BYTES`].
pub const KMSG_FLAG_TRUNCATED: u8 = 0x01;

/// Internal flag marking a pad entry. Never set on a real record.
const PAD_FLAG: u8 = 0x80;

// Header byte offsets: seq u64, ts_nsec u64, facility u8, level u8,
// flags u8, text_len u16, all little-endian and unaligned.
const OFF_SEQ: usize = 0;
const OFF_TS: usize = 8;
const OFF_FACILITY: usize = 16;
const OFF_LEVEL: usize = 17;
const OFF_FLAGS: usize = 18;
const OFF_TEXT_LEN: usize = 19;

/// Identifies one logging callsite for rate limiting. The set of callsites is
/// static, so an id is a small dense index (a syscall number, for example)
/// into a fixed table, not a handle that is allocated at run time.
pub type CallsiteId = u32;

/// The highest callsite id that gets its own limiter slot.
///
/// Callers use syscall numbers as callsite ids so a flood from one syscall
/// cannot suppress reports about another. The bound is the highest `SYS_*`
/// number defined in `crates/shared/src/lib.rs`: `SYS_SPAWN` (500, handled by
/// the host before kernel dispatch). The kernel dispatch table in
/// `wasm_api.rs` tops out at 415 and the libc glue's own `SYS_*` list at 386
/// (`SYS_EXECVEAT`). When a syscall is added past this number, raise it; the
/// `every_syscall_number_has_its_own_callsite_slot` test checks the
/// shared-crate constants.
pub const KMSG_MAX_CALLSITE_ID: CallsiteId = 500;

/// Callsite ids `0..=KMSG_MAX_CALLSITE_ID` each get their own limiter slot.
pub const KMSG_CALLSITES: usize = KMSG_MAX_CALLSITE_ID as usize + 1;

/// Records one callsite may log per window before the rest are dropped.
///
/// Ten is enough to show the first distinct occurrences of a problem with
/// their arguments, and it is the figure Linux's `printk_ratelimit` uses.
pub const KMSG_RATE_BURST: u32 = 10;

/// Length of a rate-limit window: 60 seconds of `CLOCK_MONOTONIC`.
///
/// A program spinning on an unimplemented syscall costs one burst plus one
/// count record, roughly eleven records, per window. At about 70 stored bytes
/// each that is under 1 KiB a minute per callsite, so the 128 KiB ring keeps
/// the boot log for hours of sustained flooding of a single callsite. A
/// shorter window such as Linux's 5 seconds would evict it in minutes.
pub const KMSG_RATE_INTERVAL_NSEC: u64 = 60 * 1_000_000_000;

/// A borrowed view of one record in the ring.
#[derive(Debug, Clone, Copy)]
pub struct KmsgRecordRef<'a> {
    pub seq: u64,
    /// `CLOCK_MONOTONIC` nanoseconds since kernel boot, as supplied to `push`.
    pub ts_nsec: u64,
    pub facility: u8,
    pub level: u8,
    pub flags: u8,
    pub text: &'a [u8],
}

/// One slot in the byte ring: a record or a pad, located by logical position.
struct Entry {
    /// Logical position of the entry, past any gap too small for a header.
    start: u64,
    /// Logical position just past the entry.
    end: u64,
    pad: bool,
}

/// Rate-limit state of one callsite: a fixed window with an admit budget.
#[derive(Clone, Copy)]
struct CallsiteSlot {
    /// `ts_nsec` of the first record admitted in the current window.
    window_start: u64,
    /// Records admitted in the current window; zero means no window is open.
    admitted: u32,
    /// Records dropped since the last count record was written.
    suppressed: u32,
    /// Facility and level of the most recent dropped record, which the count
    /// record borrows so a level filter treats it like what it summarizes.
    facility: u8,
    level: u8,
}

/// What the limiter decided for one record.
enum Verdict {
    /// Drop the record.
    Suppress,
    /// Admit the record. If `suppressed` is nonzero the previous window
    /// dropped that many records, and a count record must precede this one.
    Admit { suppressed: u32, facility: u8, level: u8 },
}

/// Per-callsite rate limiter over a fixed table: no allocation, ever.
///
/// Ids above [`KMSG_MAX_CALLSITE_ID`] share one extra overflow slot, so an
/// unknown callsite is still limited, just together with the other unknown
/// ones, rather than being exempt or panicking. Syscall callsites never reach
/// it; it is a safety net, not a shared bucket.
pub struct CallsiteLimiter {
    slots: [CallsiteSlot; KMSG_CALLSITES + 1],
}

impl CallsiteLimiter {
    pub const fn new() -> Self {
        CallsiteLimiter {
            slots: [CallsiteSlot { window_start: 0, admitted: 0, suppressed: 0, facility: 0, level: 0 };
                KMSG_CALLSITES + 1],
        }
    }

    fn check(&mut self, site: CallsiteId, facility: u8, level: u8, ts_nsec: u64) -> Verdict {
        let index = (site as usize).min(KMSG_CALLSITES);
        let slot = &mut self.slots[index];
        let mut suppressed = 0;
        if slot.admitted > 0 && ts_nsec.saturating_sub(slot.window_start) >= KMSG_RATE_INTERVAL_NSEC {
            // The quiet interval has passed: close the window and report it.
            suppressed = slot.suppressed;
            slot.suppressed = 0;
            slot.admitted = 0;
        }
        if slot.admitted == 0 {
            slot.window_start = ts_nsec;
        }
        if slot.admitted >= KMSG_RATE_BURST {
            slot.suppressed = slot.suppressed.saturating_add(1);
            slot.facility = facility;
            slot.level = level;
            return Verdict::Suppress;
        }
        slot.admitted += 1;
        // `suppressed` was read before the reset above, so the facility and
        // level are the ones the dropped records left behind.
        Verdict::Admit { suppressed, facility: slot.facility, level: slot.level }
    }
}

/// Fixed-size writer for the count record's text, which never allocates.
struct TextBuf {
    bytes: [u8; 40],
    len: usize,
}

impl core::fmt::Write for TextBuf {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let end = self.len + s.len();
        if end > self.bytes.len() {
            return Err(core::fmt::Error);
        }
        self.bytes[self.len..end].copy_from_slice(s.as_bytes());
        self.len = end;
        Ok(())
    }
}

pub struct KmsgRing {
    buf: [u8; KMSG_CAPACITY_BYTES],
    /// Logical position of the oldest live entry (or `head_pos` when empty).
    tail_pos: u64,
    /// Logical position the next entry is written at.
    head_pos: u64,
    oldest_seq: u64,
    next_seq: u64,
    /// Stored bytes (header plus text) of live records, excluding pads.
    live_bytes: usize,
    limiter: CallsiteLimiter,
}

impl KmsgRing {
    pub const fn new() -> Self {
        KmsgRing {
            buf: [0; KMSG_CAPACITY_BYTES],
            tail_pos: 0,
            head_pos: 0,
            oldest_seq: 0,
            next_seq: 0,
            live_bytes: 0,
            limiter: CallsiteLimiter::new(),
        }
    }

    /// Append a record and return its `seq`.
    ///
    /// Text longer than [`KMSG_MAX_TEXT_BYTES`] is truncated and the record
    /// carries [`KMSG_FLAG_TRUNCATED`]. The oldest records are evicted to make
    /// room; their `seq` values are never reused.
    pub fn push(&mut self, facility: u8, level: u8, ts_nsec: u64, text: &[u8]) -> u64 {
        let (text, flags) = if text.len() > KMSG_MAX_TEXT_BYTES {
            (&text[..KMSG_MAX_TEXT_BYTES], KMSG_FLAG_TRUNCATED)
        } else {
            (text, 0)
        };
        let size = KMSG_HEADER_BYTES + text.len();
        let offset = self.offset(self.head_pos);
        // Bytes at the end of the ring that this record cannot use.
        let gap = if offset + size > KMSG_CAPACITY_BYTES { KMSG_CAPACITY_BYTES - offset } else { 0 };

        // size <= header + max text, far below capacity, so the ring is never
        // asked to hold more than it can once everything older is evicted.
        while self.head_pos + (gap + size) as u64 - self.tail_pos > KMSG_CAPACITY_BYTES as u64 {
            self.evict_oldest();
        }

        let was_empty = self.tail_pos == self.head_pos;
        if gap > 0 {
            if gap >= KMSG_HEADER_BYTES {
                self.buf[offset + OFF_FLAGS] = PAD_FLAG;
            }
            self.head_pos += gap as u64;
        }
        if was_empty {
            // Nothing live precedes the gap, so it is not occupied.
            self.tail_pos = self.head_pos;
        }
        let at = self.offset(self.head_pos);
        let seq = self.next_seq;
        self.buf[at + OFF_SEQ..at + OFF_SEQ + 8].copy_from_slice(&seq.to_le_bytes());
        self.buf[at + OFF_TS..at + OFF_TS + 8].copy_from_slice(&ts_nsec.to_le_bytes());
        self.buf[at + OFF_FACILITY] = facility;
        self.buf[at + OFF_LEVEL] = level;
        self.buf[at + OFF_FLAGS] = flags;
        self.buf[at + OFF_TEXT_LEN..at + OFF_TEXT_LEN + 2]
            .copy_from_slice(&(text.len() as u16).to_le_bytes());
        self.buf[at + KMSG_HEADER_BYTES..at + size].copy_from_slice(text);
        self.head_pos += size as u64;
        self.next_seq += 1;
        self.live_bytes += size;
        seq
    }

    /// Append a record unless `site` has used up its burst for this window.
    ///
    /// Returns the record's `seq`, or `None` when it was dropped. The first
    /// record admitted after a window that dropped anything is preceded by a
    /// `N messages suppressed` record. That record goes through [`push`]
    /// directly: it is not charged to `site`'s budget and has no path back
    /// into the limiter, so it cannot be suppressed.
    ///
    /// [`push`]: KmsgRing::push
    pub fn push_limited(
        &mut self,
        site: CallsiteId,
        facility: u8,
        level: u8,
        ts_nsec: u64,
        text: &[u8],
    ) -> Option<u64> {
        match self.limiter.check(site, facility, level, ts_nsec) {
            Verdict::Suppress => None,
            Verdict::Admit { suppressed, facility: dropped_facility, level: dropped_level } => {
                if suppressed > 0 {
                    use core::fmt::Write;
                    let mut count = TextBuf { bytes: [0; 40], len: 0 };
                    let noun = if suppressed == 1 { "message" } else { "messages" };
                    // "4294967295 messages suppressed" is 30 bytes, so this fits.
                    let _ = write!(count, "{suppressed} {noun} suppressed");
                    self.push(dropped_facility, dropped_level, ts_nsec, &count.bytes[..count.len]);
                }
                Some(self.push(facility, level, ts_nsec, text))
            }
        }
    }

    /// Read the record with the given `seq`.
    ///
    /// `EPIPE` means the record was evicted by wraparound or `clear` (the
    /// reader was overrun); `EAGAIN` means `seq` has not been assigned yet.
    pub fn read_at(&self, seq: u64) -> Result<KmsgRecordRef<'_>, Errno> {
        if seq < self.oldest_seq {
            return Err(Errno::EPIPE);
        }
        if seq >= self.next_seq {
            return Err(Errno::EAGAIN);
        }
        let entry = self.find(seq);
        Ok(self.record(&entry))
    }

    /// The `seq` of the oldest live record; equals `head_seq` when empty.
    pub fn oldest_seq(&self) -> u64 {
        self.oldest_seq
    }

    /// One past the newest `seq`: the `seq` the next push will be assigned.
    pub fn head_seq(&self) -> u64 {
        self.next_seq
    }

    /// Discard every live record. `seq` is not reset, so a cursor into the
    /// discarded history reads `EPIPE` rather than aliasing a new record.
    pub fn clear(&mut self) {
        self.tail_pos = self.head_pos;
        self.oldest_seq = self.next_seq;
        self.live_bytes = 0;
    }

    /// Stored bytes (header plus text) of all live records.
    pub fn byte_len(&self) -> usize {
        self.live_bytes
    }

    /// Stored bytes of the live records at or after `seq`. A `seq` behind the
    /// oldest record counts from the oldest, matching where an overrun
    /// reader resumes; a `seq` at or past `head_seq` has nothing unread.
    pub fn unread_bytes(&self, seq: u64) -> usize {
        if seq <= self.oldest_seq {
            return self.live_bytes;
        }
        if seq >= self.next_seq {
            return 0;
        }
        let mut unread = 0;
        let mut pos = self.find(seq).start;
        while pos < self.head_pos {
            let entry = self.entry_at(pos);
            if !entry.pad {
                unread += KMSG_HEADER_BYTES + usize::from(self.text_len(&entry));
            }
            pos = entry.end;
        }
        unread
    }

    fn offset(&self, pos: u64) -> usize {
        (pos % KMSG_CAPACITY_BYTES as u64) as usize
    }

    /// Describe the entry at `pos`, skipping a trailing gap too small for a
    /// header. `pos` must be below `head_pos`.
    fn entry_at(&self, pos: u64) -> Entry {
        let mut start = pos;
        let mut offset = self.offset(start);
        if KMSG_CAPACITY_BYTES - offset < KMSG_HEADER_BYTES {
            start += (KMSG_CAPACITY_BYTES - offset) as u64;
            offset = 0;
        }
        if self.buf[offset + OFF_FLAGS] & PAD_FLAG != 0 {
            return Entry { start, end: start + (KMSG_CAPACITY_BYTES - offset) as u64, pad: true };
        }
        let mut entry = Entry { start, end: start, pad: false };
        entry.end = start + (KMSG_HEADER_BYTES + usize::from(self.text_len(&entry))) as u64;
        entry
    }

    fn text_len(&self, entry: &Entry) -> u16 {
        let at = self.offset(entry.start) + OFF_TEXT_LEN;
        u16::from_le_bytes([self.buf[at], self.buf[at + 1]])
    }

    /// Locate the live record `seq`, which must satisfy
    /// `oldest_seq <= seq < next_seq`.
    fn find(&self, seq: u64) -> Entry {
        let mut pos = self.tail_pos;
        loop {
            let entry = self.entry_at(pos);
            if !entry.pad && self.record(&entry).seq == seq {
                return entry;
            }
            pos = entry.end;
        }
    }

    fn record(&self, entry: &Entry) -> KmsgRecordRef<'_> {
        let at = self.offset(entry.start);
        let u64_at = |off: usize| {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&self.buf[at + off..at + off + 8]);
            u64::from_le_bytes(bytes)
        };
        let text_len = usize::from(self.text_len(entry));
        KmsgRecordRef {
            seq: u64_at(OFF_SEQ),
            ts_nsec: u64_at(OFF_TS),
            facility: self.buf[at + OFF_FACILITY],
            level: self.buf[at + OFF_LEVEL],
            flags: self.buf[at + OFF_FLAGS],
            text: &self.buf[at + KMSG_HEADER_BYTES..at + KMSG_HEADER_BYTES + text_len],
        }
    }

    /// Drop the oldest live record (and any pad before it). The ring must not
    /// be empty.
    fn evict_oldest(&mut self) {
        loop {
            let entry = self.entry_at(self.tail_pos);
            self.tail_pos = entry.end;
            if !entry.pad {
                self.live_bytes -= (entry.end - entry.start) as usize;
                self.oldest_seq += 1;
                break;
            }
        }
        // Step over a trailing gap too small for a header so it is not
        // counted as occupied.
        let offset = self.offset(self.tail_pos);
        if self.tail_pos < self.head_pos && KMSG_CAPACITY_BYTES - offset < KMSG_HEADER_BYTES {
            self.tail_pos += (KMSG_CAPACITY_BYTES - offset) as u64;
        }
    }
}

/// Wrapper for static global storage.
pub struct GlobalKmsgRing(pub UnsafeCell<KmsgRing>);

/// SAFETY: Access is serialized — the kernel services one syscall at a time.
unsafe impl Sync for GlobalKmsgRing {}

pub static KMSG_RING: GlobalKmsgRing = GlobalKmsgRing(UnsafeCell::new(KmsgRing::new()));

/// Get a mutable reference to the global kernel message ring.
///
/// # Safety
/// Caller must ensure no other references exist. Safe in single-threaded kernel.
pub unsafe fn global_kmsg_ring() -> &'static mut KmsgRing {
    unsafe { &mut *KMSG_RING.0.get() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;
    use alloc::vec::Vec;

    fn ring() -> alloc::boxed::Box<KmsgRing> {
        alloc::boxed::Box::new(KmsgRing::new())
    }

    #[test]
    fn push_assigns_monotonic_sequence_numbers() {
        let mut ring = ring();
        assert_eq!(ring.push(0, 6, 1, b"one"), 0);
        assert_eq!(ring.push(0, 6, 2, b"two"), 1);
        assert_eq!(ring.push(0, 6, 3, b"three"), 2);
    }

    #[test]
    fn read_at_returns_the_pushed_record() {
        let mut ring = ring();
        ring.push(0, 6, 10, b"first");
        let seq = ring.push(3, 4, 123_456_789, b"second record");
        let record = ring.read_at(seq).unwrap();
        assert_eq!(record.seq, seq);
        assert_eq!(record.ts_nsec, 123_456_789);
        assert_eq!(record.facility, 3);
        assert_eq!(record.level, 4);
        assert_eq!(record.flags, 0);
        assert_eq!(record.text, b"second record");
        let first = ring.read_at(0).unwrap();
        assert_eq!((first.facility, first.level, first.ts_nsec), (0, 6, 10));
        assert_eq!(first.text, b"first");
    }

    #[test]
    fn wraparound_evicts_oldest_and_keeps_seq_monotonic() {
        let mut ring = ring();
        // Varying lengths exercise every way a record can meet the end of
        // the byte ring: an exact fit, a gap too small for a header, and a
        // gap large enough to need an explicit pad.
        let total = 5_000u64;
        for i in 0..total {
            let text = format!("record {i} {}", "x".repeat((i as usize * 37) % 300));
            assert_eq!(ring.push(0, 6, i, text.as_bytes()), i);
        }
        assert_eq!(ring.head_seq(), total);
        assert!(ring.oldest_seq() > 0, "5000 records cannot fit in 128 KiB");
        assert!(ring.byte_len() <= KMSG_CAPACITY_BYTES);
        let mut live = 0;
        for seq in ring.oldest_seq()..ring.head_seq() {
            let record = ring.read_at(seq).unwrap();
            let expected = format!("record {seq} {}", "x".repeat((seq as usize * 37) % 300));
            assert_eq!(record.seq, seq);
            assert_eq!(record.ts_nsec, seq);
            assert_eq!(record.text, expected.as_bytes());
            live += 1;
        }
        assert_eq!(live, ring.head_seq() - ring.oldest_seq());
        // A push after eviction continues the sequence; no number is reused.
        assert_eq!(ring.push(0, 6, 0, b"after"), total);
    }

    #[test]
    fn read_at_evicted_seq_is_epipe() {
        let mut ring = ring();
        for i in 0..5_000u64 {
            ring.push(0, 6, i, b"filler text to force eviction");
        }
        let oldest = ring.oldest_seq();
        assert!(oldest > 0);
        assert!(matches!(ring.read_at(0), Err(Errno::EPIPE)));
        assert!(matches!(ring.read_at(oldest - 1), Err(Errno::EPIPE)));
        assert!(ring.read_at(oldest).is_ok());
        // A sequence number that has not been assigned yet is not an overrun.
        assert!(matches!(ring.read_at(ring.head_seq()), Err(Errno::EAGAIN)));
    }

    #[test]
    fn text_longer_than_capacity_is_truncated_with_the_truncation_flag() {
        let mut ring = ring();
        ring.push(0, 6, 1, b"short");
        let huge = alloc::vec![b'a'; KMSG_CAPACITY_BYTES * 2];
        let seq = ring.push(0, 6, 2, &huge);
        let record = ring.read_at(seq).unwrap();
        assert_eq!(record.text.len(), KMSG_MAX_TEXT_BYTES);
        assert!(record.text.iter().all(|&b| b == b'a'));
        assert_eq!(record.flags & KMSG_FLAG_TRUNCATED, KMSG_FLAG_TRUNCATED);
        // Truncation is reported only where it happened, and one oversized
        // record does not displace the whole ring.
        assert_eq!(ring.read_at(0).unwrap().flags, 0);
        let exact = alloc::vec![b'b'; KMSG_MAX_TEXT_BYTES];
        let seq = ring.push(0, 6, 3, &exact);
        let record = ring.read_at(seq).unwrap();
        assert_eq!(record.text.len(), KMSG_MAX_TEXT_BYTES);
        assert_eq!(record.flags & KMSG_FLAG_TRUNCATED, 0);
    }

    #[test]
    fn clear_empties_the_ring_and_does_not_reset_seq() {
        let mut ring = ring();
        for i in 0..10u64 {
            ring.push(0, 6, i, b"before clear");
        }
        ring.clear();
        assert_eq!(ring.byte_len(), 0);
        assert_eq!(ring.oldest_seq(), 10);
        assert_eq!(ring.head_seq(), 10);
        // A cursor into cleared history has been overrun, not rewound.
        assert!(matches!(ring.read_at(3), Err(Errno::EPIPE)));
        assert_eq!(ring.push(0, 6, 99, b"after clear"), 10);
        assert_eq!(ring.oldest_seq(), 10);
        assert_eq!(ring.read_at(10).unwrap().text, b"after clear");
    }

    #[test]
    fn oldest_and_head_seq_bracket_the_live_records() {
        let mut ring = ring();
        assert_eq!((ring.oldest_seq(), ring.head_seq()), (0, 0));
        for i in 0..3u64 {
            ring.push(0, 6, i, b"x");
        }
        assert_eq!((ring.oldest_seq(), ring.head_seq()), (0, 3));
        for seq in ring.oldest_seq()..ring.head_seq() {
            assert!(ring.read_at(seq).is_ok());
        }
        // Wrap the ring: the bracket moves, and every seq inside it is live.
        for i in 0..5_000u64 {
            ring.push(0, 6, i, b"filler text to force eviction");
        }
        assert_eq!(ring.head_seq(), 5_003);
        let live: Vec<u64> = (ring.oldest_seq()..ring.head_seq()).collect();
        assert!(live.iter().all(|&seq| ring.read_at(seq).is_ok()));
    }

    #[test]
    fn byte_len_and_unread_bytes_count_stored_record_bytes() {
        let mut ring = ring();
        assert_eq!(ring.byte_len(), 0);
        assert_eq!(ring.unread_bytes(0), 0);
        let a = ring.push(0, 6, 1, b"aaaa");
        let b = ring.push(0, 6, 2, b"bbbbbbbb");
        let c = ring.push(0, 6, 3, b"c");
        let size = |text_len: usize| KMSG_HEADER_BYTES + text_len;
        assert_eq!(ring.byte_len(), size(4) + size(8) + size(1));
        assert_eq!(ring.unread_bytes(a), ring.byte_len());
        assert_eq!(ring.unread_bytes(b), size(8) + size(1));
        assert_eq!(ring.unread_bytes(c), size(1));
        assert_eq!(ring.unread_bytes(ring.head_seq()), 0);
        // A cursor behind the oldest record resumes at the oldest record.
        for i in 0..5_000u64 {
            ring.push(0, 6, i, b"filler text to force eviction");
        }
        assert_eq!(ring.unread_bytes(a), ring.byte_len());
        assert_eq!(ring.unread_bytes(ring.oldest_seq()), ring.byte_len());
        let walked: usize = (ring.oldest_seq()..ring.head_seq())
            .map(|seq| size(ring.read_at(seq).unwrap().text.len()))
            .sum();
        assert_eq!(walked, ring.byte_len());
    }

    #[test]
    fn records_survive_every_size_of_gap_left_at_the_end_of_the_ring() {
        // Leave `gap` bytes before the end of the byte ring, from "none" through
        // gaps too small for a header and gaps that need a pad entry, then
        // push across the boundary and check nothing live is damaged.
        let record = KMSG_HEADER_BYTES + 1003;
        let full_records = KMSG_CAPACITY_BYTES / record - 1;
        let leftover = KMSG_CAPACITY_BYTES - full_records * record;
        for gap in 0..=40usize {
            let mut ring = ring();
            let mut expected: Vec<(u64, Vec<u8>)> = Vec::new();
            let mut push = |ring: &mut KmsgRing, text: Vec<u8>| {
                let seq = ring.push(0, 6, 7, &text);
                expected.push((seq, text));
            };
            for i in 0..full_records {
                push(&mut ring, alloc::vec![i as u8; 1003]);
            }
            // The next record ends `gap` bytes short of the end of the ring.
            push(&mut ring, alloc::vec![0xAA; leftover - gap - KMSG_HEADER_BYTES]);
            for i in 0..6usize {
                push(&mut ring, alloc::vec![0xB0 + i as u8; 300 + i * 100]);
            }
            let mut stored = 0;
            for seq in ring.oldest_seq()..ring.head_seq() {
                let (want_seq, want_text) = &expected[seq as usize];
                let got = ring.read_at(seq).unwrap();
                assert_eq!((got.seq, got.text), (*want_seq, want_text.as_slice()), "gap {gap}");
                stored += KMSG_HEADER_BYTES + got.text.len();
            }
            assert!(ring.oldest_seq() > 0, "gap {gap}: the ring must have wrapped");
            assert_eq!(ring.byte_len(), stored, "gap {gap}");
            assert_eq!(ring.unread_bytes(ring.oldest_seq() + 1), stored - (KMSG_HEADER_BYTES
                + ring.read_at(ring.oldest_seq()).unwrap().text.len()), "gap {gap}");
        }
    }

    /// Text of every live record, oldest first.
    fn texts(ring: &KmsgRing) -> Vec<Vec<u8>> {
        (ring.oldest_seq()..ring.head_seq())
            .map(|seq| ring.read_at(seq).unwrap().text.to_vec())
            .collect()
    }

    #[test]
    fn push_limited_admits_the_first_burst_then_suppresses() {
        let mut ring = ring();
        for i in 0..KMSG_RATE_BURST {
            let seq = ring.push_limited(1, 0, 4, 1_000 + u64::from(i), b"enosys");
            assert_eq!(seq, Some(u64::from(i)), "message {i} is inside the burst");
        }
        for i in 0..50 {
            assert_eq!(ring.push_limited(1, 0, 4, 2_000 + i, b"enosys"), None);
        }
        assert_eq!(ring.head_seq(), u64::from(KMSG_RATE_BURST));
    }

    #[test]
    fn suppression_emits_a_count_record_naming_how_many_were_dropped() {
        let mut ring = ring();
        let t0 = 5_000;
        for _ in 0..KMSG_RATE_BURST {
            ring.push_limited(1, 0, 4, t0, b"enosys");
        }
        for _ in 0..37 {
            assert_eq!(ring.push_limited(1, 0, 4, t0 + 1, b"enosys"), None);
        }
        // Nothing is reported until the window reopens: the kernel has no timer.
        assert_eq!(ring.head_seq(), u64::from(KMSG_RATE_BURST));

        let reopen = t0 + KMSG_RATE_INTERVAL_NSEC;
        let seq = ring.push_limited(1, 0, 4, reopen, b"after").unwrap();
        let suppression = ring.read_at(seq - 1).unwrap();
        assert_eq!(suppression.text, b"37 messages suppressed");
        assert_eq!((suppression.facility, suppression.level), (0, 4));
        assert_eq!(suppression.ts_nsec, reopen);
        let admitted = ring.read_at(seq).unwrap();
        assert_eq!(admitted.text, b"after");
        assert_eq!(admitted.ts_nsec, reopen);
    }

    #[test]
    fn a_single_dropped_message_is_reported_in_the_singular() {
        let mut ring = ring();
        for _ in 0..=KMSG_RATE_BURST {
            ring.push_limited(1, 0, 6, 0, b"x");
        }
        let seq = ring.push_limited(1, 0, 6, KMSG_RATE_INTERVAL_NSEC, b"y").unwrap();
        assert_eq!(ring.read_at(seq - 1).unwrap().text, b"1 message suppressed");
    }

    #[test]
    fn no_suppression_record_when_nothing_was_dropped() {
        let mut ring = ring();
        ring.push_limited(1, 0, 6, 0, b"once");
        let seq = ring.push_limited(1, 0, 6, KMSG_RATE_INTERVAL_NSEC * 3, b"again").unwrap();
        assert_eq!(seq, 1);
        assert_eq!(texts(&ring), [b"once".to_vec(), b"again".to_vec()]);
    }

    #[test]
    fn suppression_record_is_never_itself_suppressed() {
        // A flood must degrade to a bounded sample plus an honest count, never
        // to silence. Exhaust the burst on every callsite, then reopen each
        // window: every count record must land even though its callsite has
        // used up its budget (the reopening message takes the first slot of
        // the new window, and the count record takes none).
        let mut ring = ring();
        let sites = 8;
        for site in 0..sites {
            for _ in 0..KMSG_RATE_BURST + 5 {
                ring.push_limited(site, 0, 4, 100, b"flood");
            }
        }
        let before = ring.head_seq();
        for site in 0..sites {
            ring.push_limited(site, 0, 4, 100 + KMSG_RATE_INTERVAL_NSEC, b"next");
        }
        let counts = texts(&ring)
            .into_iter()
            .filter(|t| t.as_slice() == b"5 messages suppressed")
            .count();
        assert_eq!(counts, sites as usize);
        assert_eq!(ring.head_seq(), before + 2 * u64::from(sites));

        // The count record is not charged to its callsite: after reopening,
        // the callsite still has its full burst minus the one reopening message.
        let mut ring = self::ring();
        for _ in 0..KMSG_RATE_BURST + 1 {
            ring.push_limited(9, 0, 4, 0, b"flood");
        }
        let t = KMSG_RATE_INTERVAL_NSEC;
        for i in 0..KMSG_RATE_BURST {
            assert!(
                ring.push_limited(9, 0, 4, t, b"again").is_some(),
                "message {i} of the reopened window was starved by the count record",
            );
        }
        assert_eq!(ring.push_limited(9, 0, 4, t, b"again"), None);
    }

    #[test]
    fn distinct_callsites_are_limited_independently() {
        let mut ring = ring();
        for _ in 0..KMSG_RATE_BURST {
            assert!(ring.push_limited(1, 0, 4, 0, b"a").is_some());
        }
        assert_eq!(ring.push_limited(1, 0, 4, 0, b"a"), None);
        // Callsite 2 is untouched by callsite 1 having exhausted its burst.
        for _ in 0..KMSG_RATE_BURST {
            assert!(ring.push_limited(2, 0, 4, 0, b"b").is_some());
        }
        assert_eq!(ring.push_limited(2, 0, 4, 0, b"b"), None);
    }

    #[test]
    fn the_window_reopens_after_the_quiet_interval() {
        let mut ring = ring();
        for _ in 0..KMSG_RATE_BURST {
            ring.push_limited(1, 0, 4, 1_000, b"m");
        }
        // One nanosecond short of the interval: still closed.
        assert_eq!(ring.push_limited(1, 0, 4, 1_000 + KMSG_RATE_INTERVAL_NSEC - 1, b"m"), None);
        // Exactly the interval: open again with a fresh burst.
        for _ in 0..KMSG_RATE_BURST {
            assert!(ring.push_limited(1, 0, 4, 1_000 + KMSG_RATE_INTERVAL_NSEC, b"m").is_some());
        }
        assert_eq!(ring.push_limited(1, 0, 4, 1_000 + KMSG_RATE_INTERVAL_NSEC, b"m"), None);
    }

    #[test]
    fn callsites_above_255_are_limited_independently() {
        // Syscall numbers run past 255 (SYS_EXECVEAT is 386), and each must
        // have its own slot so a flood from one does not silence another.
        let (a, b) = (300, 386);
        let mut ring = ring();
        for _ in 0..KMSG_RATE_BURST {
            assert!(ring.push_limited(a, 0, 4, 0, b"a").is_some());
        }
        assert_eq!(ring.push_limited(a, 0, 4, 0, b"a"), None);
        for _ in 0..KMSG_RATE_BURST {
            assert!(ring.push_limited(b, 0, 4, 0, b"b").is_some(), "site {b} shared site {a}'s budget");
        }
        assert_eq!(ring.push_limited(b, 0, 4, 0, b"b"), None);
        // Neither shares the overflow slot with an out-of-range id.
        assert!(ring.push_limited(KMSG_MAX_CALLSITE_ID + 1, 0, 4, 0, b"c").is_some());
    }

    #[test]
    fn every_syscall_number_has_its_own_callsite_slot() {
        use wasm_posix_shared::abi::{extended_syscalls, host_intercepted};
        // The highest numbers in each shared-crate syscall group.
        for number in [
            extended_syscalls::SYS_THREAD_CANCEL,
            extended_syscalls::SYS_EXIT_GROUP,
            host_intercepted::SYS_EXECVEAT,
            host_intercepted::SYS_SPAWN,
        ] {
            assert!(number <= KMSG_MAX_CALLSITE_ID, "syscall {number} would share the overflow slot");
        }
    }

    #[test]
    fn an_out_of_range_callsite_is_still_limited() {
        let mut ring = ring();
        for _ in 0..KMSG_RATE_BURST {
            assert!(ring.push_limited(CallsiteId::MAX, 0, 4, 0, b"m").is_some());
        }
        assert_eq!(ring.push_limited(CallsiteId::MAX, 0, 4, 0, b"m"), None);
        assert_eq!(ring.push_limited(CallsiteId::MAX - 1, 0, 4, 0, b"m"), None);
    }

    #[test]
    fn a_flood_cannot_evict_the_boot_log() {
        let mut ring = ring();
        for i in 0..100u64 {
            ring.push(0, 6, i, b"boot: a line of the boot log");
        }
        // A million ENOSYS hits in a few simulated seconds.
        for i in 0..1_000_000u64 {
            ring.push_limited(7, 0, 4, 1_000 + i * 10_000, b"enosys: syscall 999 not implemented");
        }
        assert_eq!(ring.oldest_seq(), 0);
        assert!(ring.head_seq() < 100 + u64::from(KMSG_RATE_BURST) + 3);
        assert_eq!(ring.read_at(0).unwrap().text, b"boot: a line of the boot log");
    }

    #[test]
    fn push_limited_does_not_disturb_the_ring_layout() {
        let mut ring = ring();
        ring.push(0, 6, 1, b"plain");
        let seq = ring.push_limited(3, 1, 2, 2, b"limited").unwrap();
        let record = ring.read_at(seq).unwrap();
        assert_eq!((record.facility, record.level, record.text), (1, 2, &b"limited"[..]));
    }
}
