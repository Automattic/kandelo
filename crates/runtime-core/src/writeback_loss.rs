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

/// One recorded shared-mapping writeback loss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritebackLossRecord {
    /// The process whose mapping lost the writeback.
    pub pid: u32,
    /// The base address of the mapping, in that process's address space.
    pub map_addr: u64,
    /// Why the writeback could not be published. Kernel-authored, ASCII,
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
            map_addr,
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
    /// loss pid=12 addr=0x10000 reason=descriptor closed
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
                format!("loss pid={} addr={:#x} reason=", record.pid, record.map_addr).as_bytes(),
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

/// Render the kernel-wide log as the `/proc/kandelo/writeback_losses` content.
pub fn render_writeback_losses() -> Vec<u8> {
    unsafe { (*GLOBAL_WRITEBACK_LOSS_LOG.0.get()).render() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;

    #[test]
    fn a_loss_is_recorded_with_its_structured_fields() {
        let mut log = WritebackLossLog::new();
        log.record(12, 0x10000, "descriptor closed");
        assert_eq!(log.total(), 1);
        assert_eq!(log.dropped(), 0);
        assert_eq!(log.records().len(), 1);
        assert_eq!(log.records()[0].pid, 12);
        assert_eq!(log.records()[0].map_addr, 0x10000);
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
            text.contains("loss pid=12 addr=0x10000 reason=descriptor closed\n"),
            "{text}"
        );
        assert!(
            text.contains("loss pid=13 addr=0x20000 reason=write failed\n"),
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
        assert_eq!(log.records()[0].map_addr, 0);
        assert_eq!(
            log.records()[WRITEBACK_LOSS_RECORD_CAPACITY - 1].map_addr,
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
