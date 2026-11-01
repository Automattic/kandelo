//! Kernel-recorded shared-mapping writeback losses.
//!
//! A shared-mapping writeback loss is real data corruption: bytes a process
//! stored into a `MAP_SHARED` file mapping could not be written to the file
//! (the file refused them, for example a tmpfs that ran out of kernel memory).
//! The mapping layer keeps the dirty pages for a later attempt rather than
//! dropping them (see `memory::SharedMappingTable::sync_file_from_process`
//! and `release_all_for_process`), but the process has been told nothing, and
//! the only honest thing a kernel can do is make that fact retrievable.
//!
//! WHY THIS IS KERNEL STATE AND NOT A LOG LINE. A formatted string written to
//! a host console would cost an entry on the host API contract to deliver a
//! diagnostic that:
//!
//!   * vanished the moment it scrolled past,
//!   * could not be queried by the affected program or by an operator,
//!   * did not exist at all on a host with no console, and
//!   * arrived as prose, so nothing could count or correlate it.
//!
//! Recording it as kernel state fixes all four. The record survives the event,
//! is readable through the ordinary `read(2)` path at
//! `/proc/kandelo/writeback_losses` (no new kernel export, so the ABI surface
//! does not grow to pay for the import that went away), and carries the pid,
//! mapping address, and reason as separate fields rather than one sentence.
//!
//! THE LOSS IS ALSO REPORTED TO THE PROGRAM, AS LINUX DOES. A writeback
//! error on a file is reported once to every open file description and every
//! mapping of that file that existed when it happened (Linux's errseq
//! semantics): the next `fsync`, `fdatasync` or `close` through such a
//! description, and the next `msync` over such a mapping, fails with `EIO`.
//! See [`note_file_writeback_error`] and [`take_ofd_writeback_error`].
//!
//! ONLY A GENUINE FILE WRITE FAILURE IS RECORDED. The mapping layer's other
//! two inconsistencies -- releasing a host handle no backing held, and a
//! publication pass reaching a live process without its memory length -- can
//! only come from Kandelo's own bookkeeping, never from the file or the
//! program, so they are fatal kernel faults ([`shared_mapping_fault`]), not
//! records.
//!
//! BOUNDEDNESS IS EXPLICIT. The kernel keeps the FIRST
//! [`WRITEBACK_LOSS_RECORD_CAPACITY`] records — the earliest losses are the
//! ones that explain the cause, later ones are usually cascade — and counts
//! *every* loss in `total`. A record that could not be stored is therefore
//! never silently discarded: `dropped = total - recorded` is published in the
//! same report, so the reader always learns that more happened than is listed.

use alloc::collections::BTreeSet;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

/// How many individual loss records the kernel retains.
///
/// Bounded so a pathological guest cannot grow kernel memory without limit;
/// never zero, and never the whole story on its own — the running total is
/// kept separately and the difference is reported as `dropped`.
pub const WRITEBACK_LOSS_RECORD_CAPACITY: usize = 64;

/// Longest reason string retained per record. Reasons are short kernel-authored
/// constants (`"write failed"`, …); the cap exists so the
/// record size is bounded by construction rather than by the caller's goodwill.
pub const WRITEBACK_LOSS_REASON_MAX: usize = 64;

/// One recorded writeback loss: a mapping's dirty bytes the file refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritebackLossRecord {
    /// The process whose mapping lost the writeback.
    pub pid: u32,
    /// The mapping base address in that process.
    pub operand: u64,
    /// Why the state could not be published. Kernel-authored, ASCII,
    /// truncated to [`WRITEBACK_LOSS_REASON_MAX`] bytes.
    pub reason: Vec<u8>,
}

/// The kernel's writeback-loss record, bounded in storage and exact in count.
#[derive(Debug, Default)]
pub struct WritebackLossLog {
    records: Vec<WritebackLossRecord>,
    total: u64,
}

impl WritebackLossLog {
    pub const fn new() -> Self {
        Self {
            records: Vec::new(),
            total: 0,
        }
    }

    /// Record one loss. Always counted; stored while capacity remains, so
    /// `total` stays exact even once storage is full.
    pub fn record(&mut self, pid: u32, map_addr: u64, reason: &str) {
        self.total = self.total.saturating_add(1);
        if self.records.len() >= WRITEBACK_LOSS_RECORD_CAPACITY {
            return;
        }
        let bytes = reason.as_bytes();
        // Truncate on a byte boundary; reasons are ASCII kernel constants, and
        // a split multi-byte sequence would only ever reach a reader as bytes.
        let len = bytes.len().min(WRITEBACK_LOSS_REASON_MAX);
        self.records.push(WritebackLossRecord {
            pid,
            operand: map_addr,
            reason: bytes[..len].to_vec(),
        });
    }

    /// Every loss the kernel has ever seen, including ones not stored.
    pub fn total(&self) -> u64 {
        self.total
    }

    /// Losses counted but not stored, because storage was full.
    pub fn dropped(&self) -> u64 {
        self.total.saturating_sub(self.records.len() as u64)
    }

    /// The retained records, oldest first.
    pub fn records(&self) -> &[WritebackLossRecord] {
        &self.records
    }

    /// Render the procfs report.
    ///
    /// Line-oriented and stable, so a reader can `grep` it:
    ///
    /// ```text
    /// total 137
    /// recorded 64
    /// dropped 73
    /// loss kind=writeback pid=12 addr=0x10000 reason=descriptor closed
    /// ```
    ///
    /// `reason` is last on the line precisely because it is the only field that
    /// may contain spaces.
    pub fn render(&self) -> Vec<u8> {
        use alloc::format;
        let mut out = Vec::new();
        out.extend_from_slice(format!("total {}\n", self.total).as_bytes());
        out.extend_from_slice(format!("recorded {}\n", self.records.len()).as_bytes());
        out.extend_from_slice(format!("dropped {}\n", self.dropped()).as_bytes());
        for record in &self.records {
            out.extend_from_slice(
                format!("loss kind=writeback pid={} addr={:#x} reason=", record.pid, record.operand)
                    .as_bytes(),
            );
            out.extend_from_slice(&record.reason);
            out.push(b'\n');
        }
        out
    }
}

/// Global wrapper for static storage.
pub struct GlobalWritebackLossLog(pub UnsafeCell<WritebackLossLog>);

/// SAFETY: access is serialized exactly as [`crate::process_table::
/// GLOBAL_PROCESS_TABLE`] is — the kernel services one syscall at a time in a
/// single dedicated worker, with no concurrent Wasm execution.
unsafe impl Sync for GlobalWritebackLossLog {}

/// The single kernel-wide writeback-loss record.
pub static GLOBAL_WRITEBACK_LOSS_LOG: GlobalWritebackLossLog =
    GlobalWritebackLossLog(UnsafeCell::new(WritebackLossLog::new()));

/// Record a loss into the kernel-wide log.
pub fn record_writeback_loss(pid: u32, map_addr: u64, reason: &str) {
    unsafe { (*GLOBAL_WRITEBACK_LOSS_LOG.0.get()).record(pid, map_addr, reason) }
}

/// Stop the kernel on a shared-mapping bookkeeping fault.
///
/// These inconsistencies cannot come from a file or a program: the mapping
/// layer released an object it never pinned, or a publication pass reached a
/// live process the kernel can always answer for. Continuing would free an
/// object under a live mapping, leak it, or silently skip a process's
/// `MAP_SHARED` coherence, so the kernel traps (its fatal fault on every host)
/// instead of recording and continuing.
pub fn shared_mapping_fault(what: core::fmt::Arguments<'_>) -> ! {
    panic!("fatal shared-mapping fault: {what}")
}

/// Decide what `SharedMappingIo::process_memory_len` answers.
///
/// `seeded` is the length the entry point supplied (or the kernel derived
/// from the live process), if any. `process_is_live` is whether the kernel's
/// process table still holds the pid.
///
/// - seeded: answer the length;
/// - not seeded, process gone: answer `None`, which correctly means "skip a
///   process that no longer exists";
/// - not seeded, process live: a bookkeeping fault (see
///   [`shared_mapping_fault`]); skipping would be a silent `MAP_SHARED`
///   coherence failure.
///
/// A free function so the decision can be tested at all: the kernel's
/// `SharedMappingIo` lives in `crates/kernel/src/wasm_api.rs`, which has no
/// unit-test seam.
pub fn resolve_process_memory_len(
    pid: u32,
    seeded: Option<u64>,
    process_is_live: bool,
) -> Option<u64> {
    if let Some(len) = seeded {
        return Some(len);
    }
    if process_is_live {
        shared_mapping_fault(format_args!(
            "a publication pass reached live process {pid} without its memory length"
        ));
    }
    None
}

/// Open file descriptions (by `OfdId`) that have not yet been told about a
/// writeback error on their file.
pub struct GlobalPendingWritebackErrors(pub UnsafeCell<BTreeSet<u64>>);

/// SAFETY: serialized exactly as [`GLOBAL_WRITEBACK_LOSS_LOG`].
unsafe impl Sync for GlobalPendingWritebackErrors {}

pub static GLOBAL_PENDING_WRITEBACK_ERRORS: GlobalPendingWritebackErrors =
    GlobalPendingWritebackErrors(UnsafeCell::new(BTreeSet::new()));

/// A writeback to the kernel-owned file whose mapping identity is `file_key`
/// failed. Every open file description of that file that exists now will
/// report `EIO` once, from its next `fsync`, `fdatasync` or `close`. A
/// description opened later never sees this error, as with Linux errseq.
pub fn note_file_writeback_error(table: &crate::process_table::ProcessTable, file_key: &str) {
    mark_open_descriptions(table, None, |ofd| {
        crate::kernel_file_mapping::mapping_handle_for(ofd.file_type, ofd.host_handle)
            .and_then(crate::kernel_file_mapping::identity_key)
            .as_deref()
            == Some(file_key)
    });
}

/// A writeback of a host-mounted file (identified as its descriptions are,
/// by `host_fstat` device and inode) failed in the host's shared-mapping
/// layer. Every open description of it that exists now reports `EIO` once,
/// except `told` -- the `(pid, fd)` whose current syscall is already failing
/// with `EIO` because of this failure, so it is not told twice.
pub fn note_host_file_writeback_error(
    table: &crate::process_table::ProcessTable,
    dev: u64,
    ino: u64,
    told: Option<(u32, i32)>,
) {
    let told = told.and_then(|(pid, fd)| {
        let proc = table.get(pid)?;
        let entry = proc.fd_table.get(fd).ok()?;
        Some(proc.ofd_table.get(entry.ofd_ref.0)?.ofd_id.0)
    });
    let file = crate::lock::FileId::Host { dev, ino };
    mark_open_descriptions(table, told, |ofd| ofd.file_id == Some(file));
}

fn mark_open_descriptions(
    table: &crate::process_table::ProcessTable,
    skip: Option<u64>,
    matches: impl Fn(&crate::ofd::OpenFileDesc) -> bool,
) {
    let pending = unsafe { &mut *GLOBAL_PENDING_WRITEBACK_ERRORS.0.get() };
    for pid in table.all_pids() {
        let Some(proc) = table.get(pid) else { continue };
        for (_, ofd) in proc.ofd_table.iter() {
            if Some(ofd.ofd_id.0) != skip && matches(ofd) {
                pending.insert(ofd.ofd_id.0);
            }
        }
    }
}

/// Consume the writeback error pending for this open file description, if
/// any. True means the caller must report `EIO`.
pub fn take_ofd_writeback_error(ofd_id: u64) -> bool {
    unsafe { (*GLOBAL_PENDING_WRITEBACK_ERRORS.0.get()).remove(&ofd_id) }
}

/// Render the kernel-wide log as the `/proc/kandelo/writeback_losses` content.
pub fn render_writeback_losses() -> Vec<u8> {
    unsafe { (*GLOBAL_WRITEBACK_LOSS_LOG.0.get()).render() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;

    /// A seeded length is answered unchanged and records nothing. This is the
    /// overwhelmingly common case and must stay free of diagnostics.
    #[test]
    fn a_seeded_process_answers_its_length_and_records_nothing() {
        assert_eq!(resolve_process_memory_len(7, Some(4096), true), Some(4096));
    }

    /// A process that is genuinely gone is skipped: that is not a fault.
    #[test]
    fn a_dead_process_is_skipped() {
        assert_eq!(resolve_process_memory_len(7, None, false), None);
    }

    /// A live process reached without its memory length would have every
    /// mapping it holds skipped. The kernel answers a live process's length
    /// itself, so this can only be a bookkeeping error, and skipping would
    /// silently break MAP_SHARED coherence: the kernel stops instead.
    #[test]
    #[should_panic(expected = "fatal shared-mapping fault: a publication pass reached live process")]
    fn a_live_unseeded_process_is_a_fatal_fault() {
        let _ = resolve_process_memory_len(7, None, true);
    }

    #[test]
    fn a_loss_is_recorded_with_its_structured_fields() {
        let mut log = WritebackLossLog::new();
        log.record(12, 0x10000, "descriptor closed");
        assert_eq!(log.total(), 1);
        assert_eq!(log.dropped(), 0);
        assert_eq!(log.records().len(), 1);
        assert_eq!(log.records()[0].pid, 12);
        assert_eq!(log.records()[0].operand, 0x10000);
        assert_eq!(log.records()[0].reason, b"descriptor closed".to_vec());
    }

    #[test]
    fn the_report_names_every_field_of_every_record() {
        let mut log = WritebackLossLog::new();
        log.record(12, 0x10000, "descriptor closed");
        log.record(13, 0x20000, "write failed");
        let text = String::from_utf8(log.render()).expect("ASCII report");
        assert!(text.contains("total 2\n"), "{text}");
        assert!(text.contains("recorded 2\n"), "{text}");
        assert!(text.contains("dropped 0\n"), "{text}");
        assert!(
            text.contains("loss kind=writeback pid=12 addr=0x10000 reason=descriptor closed\n"),
            "{text}"
        );
        assert!(
            text.contains("loss kind=writeback pid=13 addr=0x20000 reason=write failed\n"),
            "{text}"
        );
    }

    #[test]
    fn losses_past_capacity_are_counted_not_silently_discarded() {
        let mut log = WritebackLossLog::new();
        let overflow = 10u64;
        for i in 0..(WRITEBACK_LOSS_RECORD_CAPACITY as u64 + overflow) {
            log.record(1, i, "write failed");
        }
        assert_eq!(log.records().len(), WRITEBACK_LOSS_RECORD_CAPACITY);
        assert_eq!(
            log.total(),
            WRITEBACK_LOSS_RECORD_CAPACITY as u64 + overflow
        );
        assert_eq!(log.dropped(), overflow);
        let text = String::from_utf8(log.render()).expect("ASCII report");
        // The whole point: the reader is told that more happened than is listed.
        assert!(
            text.contains(&alloc::format!(
                "total {}\n",
                WRITEBACK_LOSS_RECORD_CAPACITY as u64 + overflow
            )),
            "{text}"
        );
        assert!(
            text.contains(&alloc::format!(
                "recorded {WRITEBACK_LOSS_RECORD_CAPACITY}\n"
            )),
            "{text}"
        );
        assert!(text.contains(&alloc::format!("dropped {overflow}\n")), "{text}");
        // `recorded` must describe the listing, not merely appear in it.
        assert_eq!(
            text.lines().filter(|l| l.starts_with("loss ")).count(),
            WRITEBACK_LOSS_RECORD_CAPACITY
        );
    }

    #[test]
    fn the_earliest_losses_are_the_ones_kept() {
        let mut log = WritebackLossLog::new();
        for i in 0..(WRITEBACK_LOSS_RECORD_CAPACITY as u64 + 5) {
            log.record(1, i, "write failed");
        }
        // First-N, not last-N: the first losses explain the cause, later ones
        // are usually cascade from the same broken mapping.
        assert_eq!(log.records()[0].operand, 0);
        assert_eq!(
            log.records()[WRITEBACK_LOSS_RECORD_CAPACITY - 1].operand,
            WRITEBACK_LOSS_RECORD_CAPACITY as u64 - 1
        );
    }

    #[test]
    fn an_overlong_reason_is_truncated_rather_than_growing_the_record() {
        let mut log = WritebackLossLog::new();
        let long = "x".repeat(WRITEBACK_LOSS_REASON_MAX * 4);
        log.record(1, 0, &long);
        assert_eq!(log.records()[0].reason.len(), WRITEBACK_LOSS_REASON_MAX);
    }

    #[test]
    fn an_empty_log_still_reports_its_counters() {
        let log = WritebackLossLog::new();
        let text = String::from_utf8(log.render()).expect("ASCII report");
        assert_eq!(text, "total 0\nrecorded 0\ndropped 0\n");
    }
}
