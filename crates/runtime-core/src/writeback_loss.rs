//! Kernel-recorded shared-mapping writeback losses.
//!
//! A shared-mapping writeback loss is real data corruption: bytes a process
//! wrote into a `MAP_SHARED` file mapping could not be published back to the
//! file. The mapping layer already refuses to write rather than corrupt an
//! unrelated file (see `memory::SharedMappingTable::flush_fd_writeback_mapping`),
//! so the refusal is correct — but the *user* has silently lost writes, and
//! the only honest thing a kernel can do is make that fact retrievable.
//!
//! WHY THIS IS KERNEL STATE AND NOT A LOG LINE. This was a formatted string
//! handed to a `host_debug_log` import, which every host had to implement as a
//! console write. That cost one entry on the host API contract to deliver a
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
//! BOUNDEDNESS IS EXPLICIT. The kernel keeps the FIRST
//! [`WRITEBACK_LOSS_RECORD_CAPACITY`] records — the earliest losses are the
//! ones that explain the cause, later ones are usually cascade — and counts
//! *every* loss in `total`. A record that could not be stored is therefore
//! never silently discarded: `dropped = total - recorded` is published in the
//! same report, so the reader always learns that more happened than is listed.

use alloc::vec::Vec;
use core::cell::UnsafeCell;

/// How many individual loss records the kernel retains.
///
/// Bounded so a pathological guest cannot grow kernel memory without limit;
/// never zero, and never the whole story on its own — the running total is
/// kept separately and the difference is reported as `dropped`.
pub const WRITEBACK_LOSS_RECORD_CAPACITY: usize = 64;

/// Longest reason string retained per record. Reasons are short kernel-authored
/// constants (`"descriptor closed"`, `"write failed"`, …); the cap exists so the
/// record size is bounded by construction rather than by the caller's goodwill.
pub const WRITEBACK_LOSS_REASON_MAX: usize = 64;

/// What kind of shared-mapping state was lost.
///
/// Three things can go missing in the mapping layer and none may go quietly:
/// a writeback that could not be published, a host handle released by a
/// backing that never took it, and a live process whose mappings a
/// publication pass skipped. They are different losses with different
/// operands, so the record names which one it is rather than forcing a handle
/// into a field labelled `addr` -- a field label that lied would be exactly the
/// "appearance of correctness" the platform-values contract forbids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MappingLossKind {
    /// A mapping's dirty bytes could not be written back. Operand: the mapping
    /// base address in the owning process.
    Writeback,
    /// A backing released a host handle it never retained, so the handle is now
    /// unreachable for its deferred close. Operand: the handle.
    UnheldHandle,
    /// A publication pass reached a live process whose committed linear-memory
    /// length the entry point never supplied, so every mapping that process
    /// holds was skipped. The pid in the record is the whole operand; this
    /// kind has no second one.
    UnseededProcess,
}

impl MappingLossKind {
    /// The stable token used in the procfs report.
    pub fn label(self) -> &'static str {
        match self {
            Self::Writeback => "writeback",
            Self::UnheldHandle => "unheld-handle",
            Self::UnseededProcess => "unseeded-process",
        }
    }

    /// The name this kind's operand is reported under.
    fn operand_label(self) -> &'static str {
        match self {
            Self::Writeback => "addr",
            Self::UnheldHandle => "handle",
            // No operand: the pid is the loss.
            Self::UnseededProcess => "",
        }
    }
}

/// One recorded shared-mapping loss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritebackLossRecord {
    /// Which kind of loss this is; decides what `operand` means.
    pub kind: MappingLossKind,
    /// The process whose mapping lost the writeback, or 0 when the loss is not
    /// attributable to one process.
    pub pid: u32,
    /// The kind-specific numeric operand. See [`MappingLossKind`].
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

    /// Record one loss. Always counted; stored while capacity remains.
    pub fn record(&mut self, pid: u32, map_addr: u64, reason: &str) {
        self.record_kind(MappingLossKind::Writeback, pid, map_addr, reason)
    }

    /// Record one loss of any kind. Always counted; stored while capacity
    /// remains, so `total` stays exact even once storage is full.
    pub fn record_kind(
        &mut self,
        kind: MappingLossKind,
        pid: u32,
        operand: u64,
        reason: &str,
    ) {
        self.total = self.total.saturating_add(1);
        if self.records.len() >= WRITEBACK_LOSS_RECORD_CAPACITY {
            return;
        }
        let bytes = reason.as_bytes();
        // Truncate on a byte boundary; reasons are ASCII kernel constants, and
        // a split multi-byte sequence would only ever reach a reader as bytes.
        let len = bytes.len().min(WRITEBACK_LOSS_REASON_MAX);
        self.records.push(WritebackLossRecord {
            kind,
            pid,
            operand,
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
    /// loss kind=unheld-handle handle=0x29 reason=released without a retain
    /// ```
    ///
    /// The operand's FIELD NAME follows the kind, so a reader is never told a
    /// host handle is an address.
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
            match record.kind {
                MappingLossKind::Writeback => out.extend_from_slice(
                    format!(
                        "loss kind={} pid={} {}={:#x} reason=",
                        record.kind.label(),
                        record.pid,
                        record.kind.operand_label(),
                        record.operand,
                    )
                    .as_bytes(),
                ),
                MappingLossKind::UnheldHandle => out.extend_from_slice(
                    format!(
                        "loss kind={} {}={:#x} reason=",
                        record.kind.label(),
                        record.kind.operand_label(),
                        record.operand,
                    )
                    .as_bytes(),
                ),
                MappingLossKind::UnseededProcess => out.extend_from_slice(
                    format!(
                        "loss kind={} pid={} reason=",
                        record.kind.label(),
                        record.pid,
                    )
                    .as_bytes(),
                ),
            }
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

/// Record a host handle released by a backing that never retained it.
///
/// The trait method that discovers this cannot return an error, which is
/// precisely why the loss has to be recorded: the handle is now unreachable for
/// its deferred close, and the alternative is leaking it in silence.
pub fn record_unheld_handle_loss(handle: i64) {
    unsafe {
        (*GLOBAL_WRITEBACK_LOSS_LOG.0.get()).record_kind(
            MappingLossKind::UnheldHandle,
            0,
            handle as u64,
            "released without a retain",
        )
    }
}

/// Decide what `SharedMappingIo::process_memory_len` answers, recording the
/// loss when the answer is a skip that should not have happened.
///
/// `seeded` is the length the entry point supplied, if any. `process_is_live`
/// is whether the kernel's process table still holds the pid.
///
/// The three cases are deliberately separated because two of them produce the
/// same answer for opposite reasons:
///
/// - seeded: answer the length;
/// - not seeded, process gone: answer `None`, which correctly means "skip a
///   process that no longer exists";
/// - not seeded, process live: answer `None` because there is nothing else to
///   answer, and record the loss, because this skip is a silent `MAP_SHARED`
///   coherence failure rather than a correct elision.
///
/// This is a free function taking the log rather than a method on the kernel's
/// `SharedMappingIo` so the decision can be tested at all: the kernel's impl
/// lives in `crates/kernel/src/wasm_api.rs`, which has no unit-test seam.
pub fn resolve_process_memory_len(
    log: &mut WritebackLossLog,
    seeded: Option<u64>,
    process_is_live: bool,
) -> Option<u64> {
    if let Some(len) = seeded {
        return Some(len);
    }
    if process_is_live {
        log.record_kind(
            MappingLossKind::UnseededProcess,
            0,
            0,
            "live process not seeded with its memory length",
        );
    }
    None
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
        let mut log = WritebackLossLog::new();
        assert_eq!(resolve_process_memory_len(&mut log, Some(4096), true), Some(4096));
        assert_eq!(log.total(), 0);
    }

    /// A process that is genuinely gone must be skipped silently. Recording it
    /// would make every ordinary exit look like a loss, which would bury the
    /// real ones.
    #[test]
    fn a_dead_process_is_skipped_without_a_loss() {
        let mut log = WritebackLossLog::new();
        assert_eq!(resolve_process_memory_len(&mut log, None, false), None);
        assert_eq!(log.total(), 0);
    }

    /// The case the whole mechanism exists for: an entry point reached a live
    /// process without supplying its length, so every mapping that process
    /// holds is about to be skipped. The answer is still `None` — nothing else
    /// can be answered — but it must not be silent.
    #[test]
    fn a_live_unseeded_process_answers_none_and_records_the_loss() {
        let mut log = WritebackLossLog::new();
        assert_eq!(resolve_process_memory_len(&mut log, None, true), None);
        assert_eq!(log.total(), 1);
        assert_eq!(log.records().len(), 1);
        assert_eq!(log.records()[0].kind, MappingLossKind::UnseededProcess);
    }

    /// The new kind has no second operand — the pid is the whole loss — so it
    /// must not render an `addr=` or `handle=` field carrying a placeholder.
    #[test]
    fn the_unseeded_process_report_names_the_pid_and_no_operand() {
        let mut log = WritebackLossLog::new();
        log.record_kind(
            MappingLossKind::UnseededProcess,
            41,
            0,
            "live process not seeded with its memory length",
        );
        let text = String::from_utf8(log.render()).expect("ASCII report");
        assert!(
            text.contains(
                concat!(
                    "loss kind=unseeded-process pid=41 ",
                    "reason=live process not seeded with its memory length\n",
                )
            ),
            "{text}"
        );
        assert!(!text.contains("addr="), "{text}");
        assert!(!text.contains("handle="), "{text}");
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
        // A handle loss must not be reported as an address. The operand's field
        // name follows the kind precisely so a reader is never told a host
        // handle is a mapping address.
        log.record_kind(MappingLossKind::UnheldHandle, 0, 0x29, "released without a retain");
        let text = String::from_utf8(log.render()).expect("ASCII report");
        assert!(
            text.contains("loss kind=unheld-handle handle=0x29 reason=released without a retain\n"),
            "{text}"
        );
        assert!(!text.contains("handle=0x29 reason=released without a retain\n addr"), "{text}");
        assert!(text.contains("total 3\n"), "{text}");
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
