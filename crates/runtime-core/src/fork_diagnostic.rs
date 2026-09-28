//! Fork diagnostics: what a fork module reports, formatted once, here.
//!
//! A fork module issues `SYS_FORK_DIAGNOSTIC` when a fork aborts (with the
//! errno `fork()` returns and the cause it recorded) and when it has done a
//! fork's work (the frames and references it drove, the proof-of-use a test
//! reads). The kernel formats the line and queues it with the numbers; each
//! host drains the queue (`kernel_drain_fork_diagnostics`) and logs the line
//! as it is, so every host says the same thing.
//!
//! WHY THIS IS KERNEL STATE (lane F step 3c, ruling 5). The reports used to
//! be host code: the Node/browser `ForkWorker` posted Worker messages and
//! formatted the abort reason itself, and host-native printed its own
//! sentence from its own table of causes. With the fork run loop moving into
//! the fork module there is no host code left at the moment a fork aborts or
//! finishes, and two hand-kept copies of the wording had already drifted. The
//! queue raises the fork-lifecycle wake, so a host drains it from the drain
//! it already runs for fork-lifecycle events.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use wasm_posix_shared::Errno;
use wasm_posix_shared::fork_diagnostic_wire as wire;

/// One queued diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkDiagnostic {
    pub pid: u32,
    pub kind: u32,
    pub values: [u32; wire::VALUE_COUNT],
    pub text: String,
}

/// Why an abort happened, in words a reader can act on.
pub fn abort_reason(cause: u32) -> &'static str {
    match cause {
        wire::ABORT_CAUSE_FRAME_RESERVE => {
            "a continuation frame could not be reserved mid-unwind (the parent's \
             committed frames were replayed; no child was created)"
        }
        wire::ABORT_CAUSE_SEAL => {
            "the capture could not seal (the parent's frames are intact and were \
             replayed; no child was created)"
        }
        wire::ABORT_CAUSE_LAUNCH => "the kernel refused to create the child process",
        _ => "an unknown cause",
    }
}

/// The line a host logs for `kind` with `values`, or `EINVAL` for a kind
/// the kernel does not know or an abort without an errno.
pub fn format_diagnostic(kind: u32, values: &[u32; wire::VALUE_COUNT]) -> Result<String, Errno> {
    Ok(match kind {
        wire::KIND_ABORTED => {
            if values[0] == 0 {
                return Err(Errno::EINVAL);
            }
            format!(
                "fork aborted with errno={}: {}",
                values[0],
                abort_reason(values[1])
            )
        }
        wire::KIND_PARENT_FRAMES => format!("fork_module_frames={}", values[0]),
        wire::KIND_CHILD_REFERENCES => format!(
            "fork_module_references={} exnrefs_reconstructed={} \
             gc_nodes_reconstructed={} drive_steps_executed={} static_roots_published={}",
            values[0], values[1], values[2], values[3], values[4]
        ),
        wire::KIND_CHILD_FRAMES => format!("fork_module_child_frames={}", values[0]),
        wire::KIND_RUN_FAILED => {
            let detail = values[1];
            let why = match values[0] {
                wire::RUN_FAILED_UNWIND_OUTSIDE_CAPTURE => format!(
                    "a fork-unwind exception escaped while no capture was open (phase {detail})"
                ),
                wire::RUN_FAILED_RETURN_MID_CONTINUATION => format!(
                    "the guest entry returned while a fork continuation was open (phase {detail})"
                ),
                wire::RUN_FAILED_SEAL => format!(
                    "the capture could not seal and no abort could begin (errno {detail})"
                ),
                wire::RUN_FAILED_REPLAY => {
                    format!("the parent's replay could not begin (errno {detail})")
                }
                wire::RUN_FAILED_FINISH => format!("the fork could not finish (errno {detail})"),
                wire::RUN_FAILED_BAD_PHASE => format!("kernel_fork was reached in phase {detail}"),
                wire::RUN_FAILED_MODE_MISMATCH => format!(
                    "a replay reached fork() with mode {detail}, not the captured mode"
                ),
                _ => return Err(Errno::EINVAL),
            };
            format!("fork run loop failed: {why}")
        }
        _ => return Err(Errno::EINVAL),
    })
}

/// `SYS_FORK_DIAGNOSTIC` from `pid`: format and queue it.
pub fn report(pid: u32, kind: u32, values: [u32; wire::VALUE_COUNT]) -> Result<(), Errno> {
    let mut text = format_diagnostic(kind, &values)?;
    // Whole code points only: a cut in the middle of one would hand a host
    // bytes it cannot decode.
    while text.len() > wire::TEXT_CAPACITY {
        text.pop();
    }
    push(ForkDiagnostic { pid, kind, values, text });
    Ok(())
}

struct Queue {
    #[cfg(not(test))]
    records: core::cell::UnsafeCell<Vec<ForkDiagnostic>>,
}

// Kernel Wasm execution is serialized; see `fork_lifecycle.rs`.
unsafe impl Sync for Queue {}

static QUEUE: Queue = Queue {
    #[cfg(not(test))]
    records: core::cell::UnsafeCell::new(Vec::new()),
};

#[cfg(test)]
std::thread_local! {
    static TEST_RECORDS: core::cell::RefCell<Vec<ForkDiagnostic>> =
        core::cell::RefCell::new(Vec::new());
}

fn push(record: ForkDiagnostic) {
    // The same wake the fork-lifecycle queue raises: a host drains both from
    // one place.
    crate::wakeup::push(0, wasm_posix_shared::wakeup_event_wire::TYPE_FORK_LIFECYCLE);
    #[cfg(test)]
    {
        let _ = &QUEUE;
        TEST_RECORDS.with(|records| records.borrow_mut().push(record));
    }
    #[cfg(not(test))]
    unsafe { &mut *QUEUE.records.get() }.push(record);
}

/// Write up to `max` whole records into `out` and dequeue them; the rest
/// stay queued in order.
pub fn drain(out: &mut [u8], max: u32) -> u32 {
    #[cfg(test)]
    {
        TEST_RECORDS.with(|records| drain_from(&mut records.borrow_mut(), out, max))
    }
    #[cfg(not(test))]
    {
        drain_from(unsafe { &mut *QUEUE.records.get() }, out, max)
    }
}

fn drain_from(records: &mut Vec<ForkDiagnostic>, out: &mut [u8], max: u32) -> u32 {
    let count = records
        .len()
        .min(max as usize)
        .min(out.len() / wire::RECORD_BYTES);
    for (index, record) in records.iter().take(count).enumerate() {
        let at = &mut out[index * wire::RECORD_BYTES..(index + 1) * wire::RECORD_BYTES];
        at.fill(0);
        at[wire::PID_OFFSET..wire::PID_OFFSET + 4].copy_from_slice(&record.pid.to_le_bytes());
        at[wire::KIND_OFFSET..wire::KIND_OFFSET + 4].copy_from_slice(&record.kind.to_le_bytes());
        for (slot, value) in record.values.iter().enumerate() {
            let offset = wire::VALUES_OFFSET + slot * 4;
            at[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        let text = record.text.as_bytes();
        at[wire::TEXT_LEN_OFFSET..wire::TEXT_LEN_OFFSET + 4]
            .copy_from_slice(&(text.len() as u32).to_le_bytes());
        at[wire::TEXT_OFFSET..wire::TEXT_OFFSET + text.len()].copy_from_slice(text);
    }
    records.drain(..count);
    count as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn take() -> Vec<ForkDiagnostic> {
        TEST_RECORDS.with(|records| core::mem::take(&mut *records.borrow_mut()))
    }

    #[test]
    fn every_host_gets_the_same_abort_line() {
        let _ = take();
        report(7, wire::KIND_ABORTED, [95, wire::ABORT_CAUSE_SEAL, 0, 0, 0]).unwrap();
        let [record] = take().try_into().unwrap();
        assert_eq!(record.pid, 7);
        assert_eq!(
            record.text,
            "fork aborted with errno=95: the capture could not seal (the parent's frames are \
             intact and were replayed; no child was created)"
        );
    }

    #[test]
    fn proof_lines_are_the_ones_tests_read() {
        let _ = take();
        report(3, wire::KIND_PARENT_FRAMES, [4, 0, 0, 0, 0]).unwrap();
        report(4, wire::KIND_CHILD_REFERENCES, [1, 2, 3, 4, 5]).unwrap();
        report(4, wire::KIND_CHILD_FRAMES, [6, 0, 0, 0, 0]).unwrap();
        let texts: Vec<String> = take().into_iter().map(|record| record.text).collect();
        assert_eq!(
            texts,
            [
                "fork_module_frames=4",
                "fork_module_references=1 exnrefs_reconstructed=2 gc_nodes_reconstructed=3 \
                 drive_steps_executed=4 static_roots_published=5",
                "fork_module_child_frames=6",
            ]
        );
    }

    #[test]
    fn a_run_loop_failure_says_what_the_module_could_not_resume_from() {
        let _ = take();
        report(9, wire::KIND_RUN_FAILED, [wire::RUN_FAILED_BAD_PHASE, 2, 0, 0, 0]).unwrap();
        let [record] = take().try_into().unwrap();
        assert_eq!(record.text, "fork run loop failed: kernel_fork was reached in phase 2");
        assert_eq!(report(9, wire::KIND_RUN_FAILED, [99, 0, 0, 0, 0]), Err(Errno::EINVAL));
    }

    #[test]
    fn an_unknown_kind_or_an_abort_without_an_errno_is_refused() {
        let _ = take();
        assert_eq!(report(1, 99, [0; 5]), Err(Errno::EINVAL));
        assert_eq!(report(1, wire::KIND_ABORTED, [0, 1, 0, 0, 0]), Err(Errno::EINVAL));
        assert!(take().is_empty());
    }

    #[test]
    fn drain_writes_whole_records_and_keeps_the_rest() {
        let _ = take();
        report(1, wire::KIND_PARENT_FRAMES, [1, 0, 0, 0, 0]).unwrap();
        report(2, wire::KIND_CHILD_FRAMES, [2, 0, 0, 0, 0]).unwrap();
        let mut out = [0u8; wire::RECORD_BYTES + 10];
        assert_eq!(drain(&mut out, 8), 1);
        let word = |offset: usize| u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        assert_eq!(word(wire::PID_OFFSET), 1);
        assert_eq!(word(wire::KIND_OFFSET), wire::KIND_PARENT_FRAMES);
        assert_eq!(word(wire::VALUES_OFFSET), 1);
        let len = word(wire::TEXT_LEN_OFFSET) as usize;
        assert_eq!(&out[wire::TEXT_OFFSET..wire::TEXT_OFFSET + len], b"fork_module_frames=1");
        let rest = take();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].pid, 2);
    }
}
