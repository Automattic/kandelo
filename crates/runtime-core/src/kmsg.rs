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

use crate::process::HostIO;
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

/// Most decimal digits a `u64` renders to.
pub(crate) const U64_DECIMAL_DIGITS: usize = 20;

/// Render `value` in decimal into the tail of `buf` and return the digits.
///
/// Both read surfaces build their lines from numbers, in a context that must
/// not allocate, so they share this rather than going through `format!`.
pub(crate) fn format_decimal(mut value: u64, buf: &mut [u8; U64_DECIMAL_DIGITS]) -> &[u8] {
    let mut start = U64_DECIMAL_DIGITS;
    loop {
        start -= 1;
        buf[start] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            return &buf[start..];
        }
    }
}

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

/// The highest syscall number the limiter table has a slot for.
///
/// Callers use syscall numbers as callsite ids so a flood from one syscall
/// cannot suppress reports about another. The bound is the highest `SYS_*`
/// number defined in `crates/shared/src/lib.rs`: `SYS_SPAWN` (500, handled by
/// the host before kernel dispatch). The kernel dispatch table in
/// `wasm_api.rs` tops out at 415 and the libc glue's own `SYS_*` list at 386
/// (`SYS_EXECVEAT`). When a syscall is added past this number, raise it; the
/// `every_syscall_number_has_its_own_callsite_slot` test checks the
/// shared-crate constants.
pub const KMSG_MAX_SYSCALL_CALLSITE_ID: CallsiteId = 500;

/// Callsite ids reserved for the kernel's own events ([`KlogSite`]), which
/// start just above the syscall numbers so that no event is ever limited
/// together with a syscall.
pub const KMSG_FIRST_EVENT_CALLSITE: CallsiteId = KMSG_MAX_SYSCALL_CALLSITE_ID + 1;

/// How many event callsites the table has room for. [`KlogSite`] asserts at
/// compile time that it fits.
pub const KMSG_EVENT_CALLSITES: CallsiteId = 16;

/// The highest callsite id that gets its own limiter slot.
pub const KMSG_MAX_CALLSITE_ID: CallsiteId = KMSG_MAX_SYSCALL_CALLSITE_ID + KMSG_EVENT_CALLSITES;

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
    /// Nanoseconds, as supplied to `push`. The kernel's own records carry
    /// time since the ring's first reading (see [`KmsgRing::rebase`]).
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
    /// Keys [`first_time`](KmsgRing::first_time) has already answered `true`
    /// for, one bit per key. Like the records, it lives and dies with the
    /// machine.
    first_seen: u64,
    /// The raw host clock reading that [`rebase`](KmsgRing::rebase) counts
    /// from, taken on the first reading. `None` until then.
    clock_baseline: Option<u64>,
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
            first_seen: 0,
            clock_baseline: None,
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

    /// Turn a raw host `CLOCK_MONOTONIC` reading into this ring's time:
    /// nanoseconds since the first reading the ring was given. The first
    /// record therefore sits near zero, and the two hosts agree on what a
    /// timestamp means.
    ///
    /// The host's clock cannot be used as it stands: its origin is not the
    /// machine's. Node answers `process.hrtime.bigint()`, whose origin is
    /// arbitrary (typically host uptime), and a browser answers
    /// `performance.now()`, which counts from the worker's start. Rebasing the
    /// host clock instead would change what every guest `clock_gettime`
    /// returns, and POSIX asks of `CLOCK_MONOTONIC` only that it never goes
    /// backwards. So the origin is chosen here, for this one consumer.
    ///
    /// A reading earlier than the baseline (a host clock that went backwards)
    /// is reported as zero.
    pub fn rebase(&mut self, raw_nsec: u64) -> u64 {
        raw_nsec.saturating_sub(*self.clock_baseline.get_or_insert(raw_nsec))
    }

    /// Fix the baseline, so a test can check the subtraction itself.
    #[cfg(test)]
    pub(crate) fn set_clock_baseline(&mut self, raw_nsec: u64) {
        self.clock_baseline = Some(raw_nsec);
    }

    /// `true` the first time it is asked about `key` (below 64), `false`
    /// every time after. [`clear`](KmsgRing::clear) does not reset it: the
    /// records are gone, but what they reported still happened.
    pub fn first_time(&mut self, key: u8) -> bool {
        let first = !self.already_seen(key);
        self.first_seen |= 1u64 << key;
        first
    }

    /// Whether [`first_time`](KmsgRing::first_time) has already answered
    /// `true` for `key`, without spending it.
    pub fn already_seen(&self, key: u8) -> bool {
        assert!(key < 64, "first_time keys are bit positions in a u64");
        self.first_seen & (1u64 << key) != 0
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

// ---------------------------------------------------------------------------
// Writing: the kernel's own events
// ---------------------------------------------------------------------------
//
// The kernel logs by naming a [`KlogSite`] and formatting a message. Nothing
// else is on the path: no syscall is traced here. Every site below is a
// boot-, device- or process-lifecycle event, or the failure branch of an
// operation, never something that runs once per syscall. Per-syscall tracing
// is the opt-in syscall trace ring in `host/src/kernel-worker.ts`, which has
// a different budget.

/// Facility of every record the kernel writes itself.
pub const LOG_KERN: u8 = 0;
/// Severity of a condition that stopped something working.
pub const LOG_WARNING: u8 = 4;
/// Severity of a normal, noteworthy state change.
pub const LOG_INFO: u8 = 6;

/// A place in the kernel that writes to the log.
///
/// A site owns exactly one severity, [`level`](KlogSite::level), and
/// [`klog`] takes the site rather than a level, so a callsite cannot emit
/// mixed severities. That is load-bearing for the rate limiter: its
/// `N messages suppressed` record carries the level of the last record it
/// dropped, which is only a fair label for the whole count when every record
/// the site can produce has that level.
///
/// Each site also owns one limiter slot ([`id`](KlogSite::id)), above the
/// syscall numbers. Separate sites are limited separately: a flood of one
/// cannot hide another. Two sites share a subject only where their severity
/// or their flood behaviour differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum KlogSite {
    /// The kernel's identity at boot: ABI, pointer width, memory budgets.
    BootIdentity,
    /// The `/` VFS image was loaded.
    RootImageMounted,
    /// A virtual device was opened for the first time since boot.
    DeviceFirstOpen,
    /// A process died of a signal that reports a fault in the program.
    ProcessKilledByFault,
    /// A process died of any other signal.
    ProcessKilledBySignal,
    /// An `mmap` was refused because the process address space has no room.
    MmapAddressSpaceExhausted,
    /// An `mmap` was refused because the kernel could not grow its own table.
    MmapKernelMemoryExhausted,
    /// The host reported that it lacks a capability the guest asked for.
    HostCapabilityUnavailable,
}

const _: () = assert!((KlogSite::HostCapabilityUnavailable as u32) < KMSG_EVENT_CALLSITES);

impl KlogSite {
    /// Every site, for tests that must hold for all of them.
    #[cfg(test)]
    pub(crate) const ALL: [KlogSite; 8] = [
        KlogSite::BootIdentity,
        KlogSite::RootImageMounted,
        KlogSite::DeviceFirstOpen,
        KlogSite::ProcessKilledByFault,
        KlogSite::ProcessKilledBySignal,
        KlogSite::MmapAddressSpaceExhausted,
        KlogSite::MmapKernelMemoryExhausted,
        KlogSite::HostCapabilityUnavailable,
    ];

    /// The limiter slot this site owns.
    pub const fn id(self) -> CallsiteId {
        KMSG_FIRST_EVENT_CALLSITE + self as u32
    }

    /// The one severity every record from this site carries.
    pub const fn level(self) -> u8 {
        match self {
            KlogSite::BootIdentity
            | KlogSite::RootImageMounted
            | KlogSite::DeviceFirstOpen
            | KlogSite::ProcessKilledBySignal => LOG_INFO,
            KlogSite::ProcessKilledByFault
            | KlogSite::MmapAddressSpaceExhausted
            | KlogSite::MmapKernelMemoryExhausted
            | KlogSite::HostCapabilityUnavailable => LOG_WARNING,
        }
    }
}

/// Fixed-size writer for one record's text: never allocates, because the
/// kernel logs while it may be out of memory. Text beyond the buffer is
/// dropped, and one byte more than a record can hold is kept so that
/// [`KmsgRing::push`] sees the overflow and marks the record truncated.
struct EventText {
    bytes: [u8; KMSG_MAX_TEXT_BYTES + 1],
    len: usize,
}

impl core::fmt::Write for EventText {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let room = self.bytes.len() - self.len;
        let take = s.len().min(room);
        self.bytes[self.len..self.len + take].copy_from_slice(&s.as_bytes()[..take]);
        self.len += take;
        Ok(())
    }
}

/// The host's `CLOCK_MONOTONIC` as raw nanoseconds, whose origin is the host's
/// and not the machine's: callers rebase it with [`KmsgRing::rebase`]. `None`
/// when the host cannot say, and a caller then writes no record: a made-up
/// timestamp is indistinguishable from a real one.
fn monotonic_nsec<H: HostIO + ?Sized>(host: &mut H) -> Option<u64> {
    let (sec, nsec) = host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC).ok()?;
    u64::try_from(sec).ok()?.checked_mul(1_000_000_000)?.checked_add(u64::try_from(nsec).ok()?)
}

fn format_event(args: core::fmt::Arguments<'_>) -> EventText {
    use core::fmt::Write;
    let mut text = EventText { bytes: [0; KMSG_MAX_TEXT_BYTES + 1], len: 0 };
    let _ = text.write_fmt(args);
    text
}

/// Write one record from `site`, stamped now, subject to the site's rate
/// limit. Returns the record's `seq`, or `None` when nothing was written:
/// the limiter dropped it, or the host could not supply the time.
///
/// `host` is how the kernel reads the clock, so a call site must hold one.
/// Where it does not, thread it through from the caller rather than
/// stamping the record with a guess.
pub fn klog<H: HostIO + ?Sized>(host: &mut H, site: KlogSite, args: core::fmt::Arguments<'_>) -> Option<u64> {
    klog_at(host, site.id(), site.level(), args)
}

/// The writer under [`klog`]: read the clock, rebase it, format, push through
/// the limiter. Private because it takes a bare level and callsite id, which
/// [`KlogSite`] exists to keep a caller from choosing freely; each public
/// writer fixes both.
fn klog_at<H: HostIO + ?Sized>(
    host: &mut H,
    callsite: CallsiteId,
    level: u8,
    args: core::fmt::Arguments<'_>,
) -> Option<u64> {
    let raw = monotonic_nsec(host)?;
    let text = format_event(args);
    let seq = with_ring(|ring| {
        let ts_nsec = ring.rebase(raw);
        ring.push_limited(callsite, LOG_KERN, level, ts_nsec, &text.bytes[..text.len])
    });
    announce(seq)
}

/// Tell everything waiting on `/dev/kmsg` that `seq`, if there is one, was
/// just written, and hand `seq` back.
///
/// Every record the kernel writes passes through here: [`klog_at`] and
/// [`klog_once`] are the only writers of the global ring, so a reader cannot
/// be missed by one call site forgetting to say so.
///
/// This is the same notification the other character devices give
/// ([`crate::mouse::inject_event`], [`crate::clipboard::offer`]): it marks
/// the device's epoll interests ready. An edge-triggered (`EPOLLET`) waiter
/// is told of a change only by this, because it reports an event only for a
/// notification; level-triggered `epoll`, `poll` and `select` re-evaluate
/// readiness (`kmsg_device::readable`) whenever they run and need it only to
/// run sooner. A blocking `read(2)` at the tail has no kernel-owned park:
/// the host retries it on its own timer, exactly as for the mouse and
/// clipboard, and finds the record by re-reading at the unchanged cursor.
/// That retry latency is a property of how the host parks any blocking read
/// on a character device, not of this log.
///
/// It sits where a record is written rather than on any syscall path. A
/// record is a boot-, device- or process-lifecycle event or a failure
/// branch, and a record the rate limiter drops (`None`) changed nothing a
/// reader can see, so it wakes no one.
fn announce(seq: Option<u64>) -> Option<u64> {
    if seq.is_some() {
        notify_readers();
    }
    seq
}

fn notify_readers() {
    use wasm_posix_shared::epoll::{EPOLLIN, EPOLLRDNORM};
    // Under test a writer that has not selected the global ring writes to its
    // own thread's ring, which no `/dev/kmsg` reads. Waking the machine-global
    // epoll table for it would let one test's record disturb another test's
    // waiters.
    #[cfg(test)]
    if !USE_GLOBAL_RING.with(|selected| selected.get()) {
        return;
    }
    crate::epoll::notify(
        crate::epoll::Source::Device(crate::syscalls::VirtualDevice::Kmsg.host_handle()),
        EPOLLIN | EPOLLRDNORM,
    );
}

/// The syscalls the dispatcher refuses by name: numbers that Kandelo's libc
/// binds to a function (`libc/musl-overlay/arch/*/bits/syscall.h.in`) and the
/// kernel has no implementation of. [`klog_unimplemented_syscall`] names
/// them in the log so a reader can tell which function is missing.
///
/// Not a table of every refused number: a stub whose identity the overlay does
/// not record is reported by number alone, and a number that is no syscall at
/// all is [`klog_unknown_syscall`]'s. Only the names Kandelo's own header gives
/// are listed; none is borrowed from another system's table. A test holds each
/// entry to the header.
pub(crate) const UNIMPLEMENTED_SYSCALL_NAMES: &[(u32, &str)] = &[
    (247, "inotify_init1"),
    (248, "inotify_add_watch"),
    (249, "inotify_rm_watch"),
    (253, "recvmmsg"),
    (254, "sendmmsg"),
    (265, "chroot"),
    (266, "mount"),
    (267, "umount2"),
    (268, "reboot"),
    (287, "personality"),
    (289, "unshare"),
    (292, "tee"),
    (301, "acct"),
    (302, "capget"),
    (303, "capset"),
    (305, "ptrace"),
    (309, "name_to_handle_at"),
    (310, "open_by_handle_at"),
    (311, "setns"),
    (312, "process_vm_readv"),
    (313, "process_vm_writev"),
    (314, "pivot_root"),
    (315, "swapon"),
    (316, "swapoff"),
    (317, "delete_module"),
    (318, "init_module"),
    (319, "quotactl"),
    (320, "sethostname"),
    (321, "setdomainname"),
    (322, "vhangup"),
    (324, "remap_file_pages"),
    (348, "fanotify_init"),
    (349, "fanotify_mark"),
    (363, "utimes"),
    (364, "futimesat"),
    (365, "clock_adjtime"),
    (366, "adjtimex"),
    (367, "settimeofday"),
    (368, "semtimedop"),
    (369, "vmsplice"),
    (374, "set_thread_area"),
    (375, "ioperm"),
    (376, "iopl"),
    (381, "inotify_init"),
];

fn unimplemented_syscall_name(number: u32) -> Option<&'static str> {
    UNIMPLEMENTED_SYSCALL_NAMES.iter().find(|(known, _)| *known == number).map(|(_, name)| *name)
}

/// Report that the kernel refused syscall `number`, a syscall it knows of and
/// has no implementation for: the `ENOSYS` answer, and nothing else.
///
/// A POSIX program learns of a missing function from one errno it may never
/// print, and POSIX has no facility for asking the system what it refused.
/// This is that facility's answer, so that a person assembling an image or
/// porting software can read the gap from the log: `ENOSYS` is a gap the
/// platform has not closed, and it stays visible as one.
///
/// Call it only from the arm that has no implementation for `number`. A
/// syscall that exists and rejects its caller's arguments, with `ENOSYS` or
/// any other errno, is the caller's error and is not reported.
///
/// Each such syscall number owns its own limiter slot (the number is the
/// callsite id), so a program spinning on one missing syscall cannot hide a
/// different one. That independence is affordable only because the set of
/// these numbers is small and fixed. A number the kernel does not know at all
/// is [`klog_unknown_syscall`]'s, which shares one slot, because a guest
/// chooses the number it passes and could otherwise write a burst per number
/// until the boot log was gone. A number above [`KMSG_MAX_SYSCALL_CALLSITE_ID`]
/// also lands in the shared slot: it would otherwise spend a kernel event's.
///
/// `pid` is the process that made the call, so a reader can tell which of
/// several running programs is hitting the gap. A limiter slot is per syscall
/// number, not per process: two programs spinning on the same missing syscall
/// share one burst.
///
/// The syscall's name is added where Kandelo's libc header records one
/// ([`UNIMPLEMENTED_SYSCALL_NAMES`]).
pub fn klog_unimplemented_syscall<H: HostIO + ?Sized>(host: &mut H, pid: u32, number: u32) -> Option<u64> {
    let callsite = if number <= KMSG_MAX_SYSCALL_CALLSITE_ID { number } else { SHARED_UNKNOWN_SYSCALL_CALLSITE };
    match unimplemented_syscall_name(number) {
        Some(name) => klog_at(
            host,
            callsite,
            LOG_WARNING,
            format_args!("pid {pid} called syscall {number} ({name}), which is not implemented (ENOSYS)"),
        ),
        None => klog_at(
            host,
            callsite,
            LOG_WARNING,
            format_args!("pid {pid} called syscall {number}, which is not implemented (ENOSYS)"),
        ),
    }
}

/// The one limiter slot every unknown syscall number shares: the limiter's
/// overflow slot, which no event or named syscall owns.
const SHARED_UNKNOWN_SYSCALL_CALLSITE: CallsiteId = CallsiteId::MAX;

/// Report that a process called syscall `number`, which the kernel has no
/// handler for and no record of: garbage, or a number from some other ABI.
///
/// Unlike [`klog_unimplemented_syscall`] this is one limiter slot for every
/// such number. They carry little diagnostic value one by one, and they are
/// the unbounded set: a guest that calls each of hundreds of distinct numbers
/// a few times would, with a slot apiece, write enough records to push the
/// boot log out of the ring. Sharing the slot caps the whole sweep at one
/// burst plus its suppression count.
pub fn klog_unknown_syscall<H: HostIO + ?Sized>(host: &mut H, pid: u32, number: u32) -> Option<u64> {
    klog_at(
        host,
        SHARED_UNKNOWN_SYSCALL_CALLSITE,
        LOG_WARNING,
        format_args!("pid {pid} called unknown syscall {number} (ENOSYS)"),
    )
}

/// [`klog`], but only the first time `key` (below 64) is seen since boot.
///
/// For events that mark a thing becoming live, such as a device's first
/// open: the limiter would let the first ten opens through, which is not
/// "the first". The latch is spent only after a record has been written, so
/// neither a clock failure nor a rate-limit drop uses up the one chance.
///
/// Keys are one namespace across every site, so two callers must not pick the
/// same number.
pub fn klog_once<H: HostIO + ?Sized>(
    host: &mut H,
    site: KlogSite,
    key: u8,
    args: core::fmt::Arguments<'_>,
) -> Option<u64> {
    // Checked before the clock is read, so that the second and every later
    // open of a device costs a bit test and not a call out to the host.
    if with_ring(|ring| ring.already_seen(key)) {
        return None;
    }
    let raw = monotonic_nsec(host)?;
    let text = format_event(args);
    let seq = with_ring(|ring| {
        let ts_nsec = ring.rebase(raw);
        let seq = ring.push_limited(site.id(), LOG_KERN, site.level(), ts_nsec, &text.bytes[..text.len])?;
        ring.first_time(key);
        Some(seq)
    });
    announce(seq)
}

/// Run `f` on the ring the kernel's own events are written to.
#[cfg(not(test))]
pub(crate) fn with_ring<R>(f: impl FnOnce(&mut KmsgRing) -> R) -> R {
    // SAFETY: the kernel services one syscall at a time.
    f(unsafe { global_kmsg_ring() })
}

#[cfg(test)]
std::thread_local! {
    static TEST_RING: core::cell::RefCell<alloc::boxed::Box<KmsgRing>> =
        core::cell::RefCell::new(alloc::boxed::Box::new(KmsgRing::new()));
    static USE_GLOBAL_RING: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
}

/// Under test each thread writes its own events to its own ring, so a test
/// that kills a process or opens a device cannot put records into the global
/// ring that `/dev/kmsg` and `klogctl` tests are reading. A test that needs
/// the global ring, to prove the writer and the readers share it, asks for it
/// with [`with_global_ring_selected`].
#[cfg(test)]
pub(crate) fn with_ring<R>(f: impl FnOnce(&mut KmsgRing) -> R) -> R {
    if USE_GLOBAL_RING.with(|selected| selected.get()) {
        // SAFETY: tests that select the global ring hold `kmsg_device::TEST_LOCK`.
        return f(unsafe { global_kmsg_ring() });
    }
    TEST_RING.with(|ring| f(&mut ring.borrow_mut()))
}

/// Run `f` with [`klog`] writing to the global ring: the one the readers read.
#[cfg(test)]
pub(crate) fn with_global_ring_selected<R>(f: impl FnOnce() -> R) -> R {
    struct Deselect;
    impl Drop for Deselect {
        fn drop(&mut self) {
            USE_GLOBAL_RING.with(|selected| selected.set(false));
        }
    }
    USE_GLOBAL_RING.with(|selected| selected.set(true));
    let _deselect = Deselect;
    f()
}

/// Start the calling thread's test ring over: empty, sequence at zero, no
/// once-latch spent and no clock baseline taken.
#[cfg(test)]
pub(crate) fn reset_test_ring() {
    TEST_RING.with(|ring| **ring.borrow_mut() = KmsgRing::new());
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

    // ---- klog: the writer ------------------------------------------------

    use crate::test_fixtures::ClockHost;

    /// Records of the calling thread's ring, as (level, ts_nsec, text).
    fn logged() -> Vec<(u8, u64, alloc::string::String)> {
        with_ring(|ring| {
            (ring.oldest_seq()..ring.head_seq())
                .map(|seq| {
                    let record = ring.read_at(seq).unwrap();
                    (record.level, record.ts_nsec, alloc::string::String::from_utf8_lossy(record.text).into_owned())
                })
                .collect()
        })
    }

    #[test]
    fn klog_stamps_the_record_from_the_monotonic_clock() {
        reset_test_ring();
        // The ring counts from a baseline earlier than this reading, so the
        // subtraction is checked and not only the read.
        with_ring(|ring| ring.set_clock_baseline(2_000_000_000));
        let mut host = ClockHost::at(12, 345_678_901);
        let seq = klog(&mut host, KlogSite::BootIdentity, format_args!("hello {}", 7));
        assert!(seq.is_some());
        assert_eq!(host.clock_reads, 1);
        assert_eq!(logged(), [(LOG_INFO, 10_345_678_901, "hello 7".into())]);
        with_ring(|ring| assert_eq!(ring.read_at(seq.unwrap()).unwrap().facility, LOG_KERN));
    }

    #[test]
    fn klog_timestamps_count_from_the_first_reading_whatever_the_hosts_origin() {
        // Two hosts whose CLOCK_MONOTONIC has different origins (host uptime,
        // a worker's start) must produce the same log for the same elapsed time.
        let mut logs = Vec::new();
        for origin in [4_000, 40_000_000i64] {
            reset_test_ring();
            klog(&mut ClockHost::at(origin, 0), KlogSite::BootIdentity, format_args!("first"));
            klog(&mut ClockHost::at(origin + 2, 500), KlogSite::BootIdentity, format_args!("later"));
            logs.push(logged());
        }
        assert_eq!(logs[0], logs[1]);
        assert_eq!(logs[0][0].1, 0, "the first record sits at zero");
        assert_eq!(logs[0][1].1, 2_000_000_500);

        // A host clock that steps back is reported as zero, not as a huge
        // wrapped value.
        klog(&mut ClockHost::at(1, 0), KlogSite::BootIdentity, format_args!("back"));
        assert_eq!(logged().last().unwrap().1, 0);

        // Starting the test ring over forgets the baseline.
        reset_test_ring();
        klog(&mut ClockHost::at(777, 0), KlogSite::BootIdentity, format_args!("again"));
        assert_eq!(logged()[0].1, 0);
    }

    #[test]
    fn klog_gives_each_record_the_level_its_callsite_owns() {
        // One level per callsite is what lets the limiter's
        // "N messages suppressed" record carry the level of what it
        // summarises: a callsite cannot mix severities.
        for site in KlogSite::ALL {
            reset_test_ring();
            let mut host = ClockHost::at(1, 0);
            klog(&mut host, site, format_args!("x"));
            assert_eq!(logged()[0].0, site.level(), "{site:?}");
        }
        assert!(KlogSite::ALL.iter().any(|site| site.level() == LOG_WARNING));
        assert!(KlogSite::ALL.iter().any(|site| site.level() == LOG_INFO));
    }

    #[test]
    fn klog_callsite_ids_are_distinct_and_clear_of_the_syscall_numbers() {
        let mut ids: Vec<CallsiteId> = KlogSite::ALL.iter().map(|site| site.id()).collect();
        for id in &ids {
            // Syscall numbers keep their own slots for the unimplemented-syscall
            // report; an event sharing one would be rate-limited with it.
            assert!(*id > wasm_posix_shared::abi::host_intercepted::SYS_SPAWN, "{id} collides with a syscall");
            assert!(*id <= KMSG_MAX_CALLSITE_ID, "{id} would share the overflow slot");
        }
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), KlogSite::ALL.len());
    }

    #[test]
    fn klog_with_an_unreadable_clock_records_nothing() {
        // A record with a made-up timestamp is indistinguishable from a real
        // one at boot, so the record is dropped, not stamped zero.
        reset_test_ring();
        let mut host = ClockHost { monotonic: Err(Errno::EIO), clock_reads: 0 };
        assert_eq!(klog(&mut host, KlogSite::BootIdentity, format_args!("x")), None);
        let mut negative = ClockHost::at(-1, 0);
        assert_eq!(klog(&mut negative, KlogSite::BootIdentity, format_args!("x")), None);
        assert_eq!(klog_once(&mut host, KlogSite::DeviceFirstOpen, 0, format_args!("x")), None);
        assert!(logged().is_empty());
        // The failed attempt must not have spent the once-latch.
        let mut host = ClockHost::at(1, 0);
        assert!(klog_once(&mut host, KlogSite::DeviceFirstOpen, 0, format_args!("x")).is_some());
    }

    #[test]
    fn klog_is_rate_limited_per_callsite() {
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        for _ in 0..KMSG_RATE_BURST {
            assert!(klog(&mut host, KlogSite::ProcessKilledBySignal, format_args!("a")).is_some());
        }
        assert_eq!(klog(&mut host, KlogSite::ProcessKilledBySignal, format_args!("a")), None);
        // Another callsite has its own budget: a flood of ordinary signal
        // deaths cannot hide a fault.
        assert!(klog(&mut host, KlogSite::ProcessKilledByFault, format_args!("b")).is_some());
    }

    #[test]
    fn klog_truncates_overlong_text_and_marks_the_record() {
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        let long = "y".repeat(KMSG_MAX_TEXT_BYTES + 500);
        let seq = klog(&mut host, KlogSite::BootIdentity, format_args!("{long}")).unwrap();
        with_ring(|ring| {
            let record = ring.read_at(seq).unwrap();
            assert_eq!(record.text.len(), KMSG_MAX_TEXT_BYTES);
            assert_eq!(record.flags, KMSG_FLAG_TRUNCATED);
        });
        // Text that exactly fits is not marked.
        let exact = "z".repeat(KMSG_MAX_TEXT_BYTES);
        let seq = klog(&mut host, KlogSite::BootIdentity, format_args!("{exact}")).unwrap();
        with_ring(|ring| assert_eq!(ring.read_at(seq).unwrap().flags, 0));
    }

    #[test]
    fn klog_once_is_not_spent_by_a_record_the_limiter_drops() {
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        // The device site's burst is used up by other records.
        for _ in 0..KMSG_RATE_BURST {
            assert!(klog(&mut host, KlogSite::DeviceFirstOpen, format_args!("filler")).is_some());
        }
        assert_eq!(klog_once(&mut host, KlogSite::DeviceFirstOpen, 9, format_args!("dropped")), None);
        // A window later the same event is still "the first".
        let mut later = ClockHost::at(1 + 61, 0);
        assert!(klog_once(&mut later, KlogSite::DeviceFirstOpen, 9, format_args!("kept")).is_some());
        assert!(logged().iter().any(|(_, _, text)| text == "kept"));
    }

    #[test]
    fn klog_once_records_the_first_time_for_each_key_only() {
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        assert!(klog_once(&mut host, KlogSite::DeviceFirstOpen, 3, format_args!("first")).is_some());
        let reads = host.clock_reads;
        assert_eq!(klog_once(&mut host, KlogSite::DeviceFirstOpen, 3, format_args!("again")), None);
        assert_eq!(host.clock_reads, reads, "a repeat does not call out to the host");
        assert!(klog_once(&mut host, KlogSite::DeviceFirstOpen, 4, format_args!("other")).is_some());
        assert_eq!(logged().len(), 2);
        // Clearing the log does not forget what was seen: the record is gone,
        // the device has still been opened.
        with_ring(|ring| ring.clear());
        assert_eq!(klog_once(&mut host, KlogSite::DeviceFirstOpen, 3, format_args!("again")), None);
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

    // ---- klog_unimplemented_syscall: ENOSYS reporting ----------------------

    /// The text of every record in the calling thread's ring.
    fn texts_logged() -> Vec<alloc::string::String> {
        logged().into_iter().map(|(_, _, text)| text).collect()
    }

    #[test]
    fn an_unimplemented_syscall_records_its_number_and_name() {
        reset_test_ring();
        let mut host = ClockHost::at(5, 0);
        assert!(klog_unimplemented_syscall(&mut host, 42, 247).is_some());
        // A stub Kandelo's libc header does not name is reported by number, and
        // each record names the process that made the call.
        assert!(klog_unimplemented_syscall(&mut host, 7, 362).is_some());
        assert_eq!(
            logged().iter().map(|(level, _, text)| (*level, text.as_str())).collect::<Vec<_>>(),
            [
                (LOG_WARNING, "pid 42 called syscall 247 (inotify_init1), which is not implemented (ENOSYS)"),
                (LOG_WARNING, "pid 7 called syscall 362, which is not implemented (ENOSYS)"),
            ]
        );
        with_ring(|ring| assert_eq!(ring.read_at(0).unwrap().facility, LOG_KERN));
    }

    #[test]
    fn personality_is_refused_by_name_not_answered_with_a_fabricated_value() {
        // personality(2) is Linux-only and Kandelo has no execution-domain
        // concept, so the dispatcher refuses 287 as unimplemented. The log
        // must say which function was refused: a bare number would hide that
        // the gap is one a Linux program is likely to probe at startup.
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        assert!(klog_unimplemented_syscall(&mut host, 9, 287).is_some());
        assert_eq!(
            texts_logged(),
            ["pid 9 called syscall 287 (personality), which is not implemented (ENOSYS)"]
        );
    }

    #[test]
    fn a_spinning_caller_is_suppressed_and_the_boot_log_survives() {
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        klog(&mut host, KlogSite::BootIdentity, format_args!("boot: identity"));
        klog(&mut host, KlogSite::RootImageMounted, format_args!("boot: root mounted"));

        // A program retrying inotify_init1 in a tight loop: a hundred thousand
        // refusals inside one rate-limit window.
        let spins = 100_000u64;
        let mut written = 0;
        for i in 0..spins {
            let mut host = ClockHost::at(1, i as i64);
            if klog_unimplemented_syscall(&mut host, 42, 247).is_some() {
                written += 1;
            }
        }
        assert_eq!(written, KMSG_RATE_BURST as u64, "only the burst is admitted");

        // The boot log is intact, and the ring holds the two boot records and
        // the burst, not the flood.
        let lines = texts_logged();
        assert_eq!(lines[0], "boot: identity");
        assert_eq!(lines[1], "boot: root mounted");
        assert_eq!(lines.len(), 2 + KMSG_RATE_BURST as usize);

        // A different unimplemented syscall has its own budget, however hard
        // the first is spinning.
        assert!(klog_unimplemented_syscall(&mut ClockHost::at(1, spins as i64), 42, 248).is_some());

        // After the quiet interval the window reopens and the count of what was
        // dropped is reported.
        let mut later = ClockHost::at(1 + 61, 0);
        assert!(klog_unimplemented_syscall(&mut later, 42, 247).is_some());
        let dropped = spins - u64::from(KMSG_RATE_BURST);
        assert!(
            texts_logged().contains(&format!("{dropped} messages suppressed")),
            "the suppression record must say how many were dropped",
        );
    }

    #[test]
    fn syscall_numbers_outside_the_syscall_range_cannot_borrow_an_event_slot() {
        // A guest chooses its syscall number. One just above the syscall range
        // must not land on a kernel event's slot and spend that event's burst.
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        for number in (KMSG_MAX_SYSCALL_CALLSITE_ID + 1)..=KMSG_MAX_CALLSITE_ID + 1 {
            for _ in 0..KMSG_RATE_BURST + 1 {
                klog_unimplemented_syscall(&mut host, 42, number);
            }
        }
        for site in KlogSite::ALL {
            assert!(klog(&mut host, site, format_args!("event")).is_some(), "{site:?} lost its budget");
        }
    }

    #[test]
    fn a_syscall_that_cannot_be_timestamped_is_not_reported() {
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        host.monotonic = Err(wasm_posix_shared::Errno::ENOSYS);
        assert_eq!(klog_unimplemented_syscall(&mut host, 42, 247), None);
        assert!(logged().is_empty());
    }

    #[test]
    fn enosys_records_do_not_appear_for_implemented_syscalls() {
        // futex is implemented; an operation it does not support is refused by
        // its own handler with ENOSYS. That is a rejected argument and not a
        // missing syscall. A change that reported every ENOSYS, rather than
        // only the dispatcher arms with no implementation, would start to
        // list it as a platform gap, and this would fail. `ClockHost` is a
        // host that would stamp a record if one were written.
        use crate::syscalls::{sys_futex, GuestTask};
        const NO_SUCH_FUTEX_OP: u32 = 99;
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        let outcome = sys_futex(&mut host, GuestTask::wasm32(5, 5), 0x100, NO_SUCH_FUTEX_OP, 0, 0, 0, 0);
        assert_eq!(outcome.err(), Some(wasm_posix_shared::Errno::ENOSYS));
        assert!(logged().is_empty(), "an implemented syscall's ENOSYS was reported: {:?}", texts_logged());
        assert_eq!(host.clock_reads, 0, "nothing was reported, so nothing was stamped");
    }

    #[test]
    fn a_sweep_of_distinct_unknown_syscall_numbers_cannot_flush_the_boot_log() {
        // Unlike the named stubs, the numbers a guest can make up are
        // unbounded. A slot apiece would admit KMSG_RATE_BURST records for each
        // of the ~500 numbers in the syscall range, about 5000 records, far
        // more than the ring holds (131072 bytes at ~100 a record).
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        klog(&mut host, KlogSite::BootIdentity, format_args!("boot: identity"));
        klog(&mut host, KlogSite::RootImageMounted, format_args!("boot: root mounted"));

        for number in 0..=KMSG_MAX_SYSCALL_CALLSITE_ID + 100 {
            for _ in 0..KMSG_RATE_BURST * 2 {
                klog_unknown_syscall(&mut host, 42, number);
            }
        }

        let lines = texts_logged();
        assert_eq!(lines[0], "boot: identity");
        assert_eq!(lines[1], "boot: root mounted");
        // The whole sweep is one burst.
        assert_eq!(lines.len(), 2 + KMSG_RATE_BURST as usize, "{lines:?}");
        assert_eq!(with_ring(|ring| ring.oldest_seq()), 0, "the boot records were evicted");

        // The sweep did not use up a named stub's budget, and the kernel's own
        // events keep theirs.
        assert!(klog_unimplemented_syscall(&mut host, 42, 248).is_some());
        assert!(klog(&mut host, KlogSite::ProcessKilledByFault, format_args!("event")).is_some());
    }

    #[test]
    fn an_unknown_syscall_is_reported_as_unknown() {
        reset_test_ring();
        assert!(klog_unknown_syscall(&mut ClockHost::at(1, 0), 9, 777).is_some());
        assert_eq!(texts_logged(), ["pid 9 called unknown syscall 777 (ENOSYS)"]);
    }

    #[test]
    fn named_stub_syscalls_are_named_and_unnamed_ones_are_not() {
        reset_test_ring();
        let mut host = ClockHost::at(1, 0);
        klog_unimplemented_syscall(&mut host, 3, 319);
        klog_unimplemented_syscall(&mut host, 3, 253);
        assert_eq!(
            texts_logged(),
            [
                "pid 3 called syscall 319 (quotactl), which is not implemented (ENOSYS)",
                "pid 3 called syscall 253 (recvmmsg), which is not implemented (ENOSYS)",
            ]
        );
    }

    #[test]
    fn the_stub_names_are_the_ones_kandelos_libc_header_binds() {
        // The names come from the libc overlay's syscall headers, Kandelo's own
        // record of which function each number is. Hold every entry to both
        // headers so a renumbering cannot leave the log naming the wrong one.
        let headers = [
            include_str!("../../../libc/musl-overlay/arch/wasm32posix/bits/syscall.h.in"),
            include_str!("../../../libc/musl-overlay/arch/wasm64posix/bits/syscall.h.in"),
        ];
        let mut previous = 0;
        for &(number, name) in UNIMPLEMENTED_SYSCALL_NAMES {
            assert!(number > previous, "the table must be sorted and free of duplicates at {number}");
            assert!(number <= KMSG_MAX_SYSCALL_CALLSITE_ID, "{name} would not have a slot of its own");
            previous = number;
            for header in headers {
                let defined = header.lines().any(|line| {
                    let mut words = line.split_whitespace();
                    words.next() == Some("#define")
                        && words.next() == Some(&format!("__NR_{name}")[..])
                        && words.next().and_then(|value| value.parse::<u32>().ok()) == Some(number)
                });
                assert!(defined, "the libc header does not define __NR_{name} as {number}");
            }
        }
    }
}
