//! The GPU device's FIFO of encoded submission records.
//!
//! Ownership: the GPU device (`super`) is the only producer; the host GPU
//! adapter is the only consumer, through `KgpuDevice::drain_outbox`. The
//! kernel never waits on the consumer, so the outbox is bounded in bytes and
//! a record that does not fit waits in a backlog behind it, in order. A
//! submitter whose record lands in the backlog is parked until the record
//! reaches the outbox; control records (create, destroy) have no caller to
//! park and simply wait their turn.

extern crate alloc;

use alloc::collections::VecDeque;
use alloc::vec::Vec;

use wasm_posix_shared::Errno;

/// The outbox's byte capacity. The host must drain into a buffer at least
/// this large: every record fits within it (`KgpuDevice` refuses a larger
/// submission), so such a buffer always takes at least the first record.
pub const OUTBOX_CAPACITY: usize = 256 * 1024;

pub struct Record {
    pub bytes: Vec<u8>,
    pub context: u32,
    /// The sequence number of a submit record; `None` for control records.
    pub submit: Option<u64>,
    /// Its submitter is parked until the record reaches the outbox.
    pub parked: bool,
}

pub struct Outbox {
    ready: VecDeque<Record>,
    ready_bytes: usize,
    backlog: VecDeque<Record>,
}

impl Outbox {
    pub const fn new() -> Self {
        Self {
            ready: VecDeque::new(),
            ready_bytes: 0,
            backlog: VecDeque::new(),
        }
    }

    /// Make room to queue one more record, so `push` cannot fail after the
    /// caller has committed state the record describes.
    pub fn reserve(&mut self) -> Result<(), Errno> {
        self.ready.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
        self.backlog.try_reserve(1).map_err(|_| Errno::ENOMEM)
    }

    /// Queue a record; returns whether it went straight to the outbox. A
    /// nonempty backlog takes every new record, so order is preserved.
    pub fn push(&mut self, record: Record) -> bool {
        let len = record.bytes.len();
        if self.backlog.is_empty() && self.ready_bytes + len <= OUTBOX_CAPACITY {
            self.ready_bytes += len;
            self.ready.push_back(record);
            true
        } else {
            self.backlog.push_back(record);
            false
        }
    }

    pub fn mark_parked(&mut self, seqno: u64) {
        if let Some(record) = self.backlog.iter_mut().find(|r| r.submit == Some(seqno)) {
            record.parked = true;
        }
    }

    /// Whether the submit `seqno` still waits in the backlog.
    pub fn holds_in_backlog(&self, seqno: u64) -> bool {
        self.backlog.iter().any(|r| r.submit == Some(seqno))
    }

    /// Whether a submit of `context` at or below `seqno` has not been
    /// drained yet: the host cannot have retired it.
    pub fn holds_submit_through(&self, context: u32, seqno: u64) -> bool {
        self.ready
            .iter()
            .chain(self.backlog.iter())
            .any(|r| r.context == context && r.submit.is_some_and(|s| s <= seqno))
    }

    /// Copy whole records from the front of the outbox into `out`, then
    /// admit backlog records into the freed room. Returns the bytes written
    /// and whether an admitted record's submitter is parked.
    pub fn drain(&mut self, out: &mut [u8]) -> (usize, bool) {
        let mut written = 0;
        while let Some(front) = self.ready.front() {
            let len = front.bytes.len();
            if written + len > out.len() {
                break;
            }
            out[written..written + len].copy_from_slice(&front.bytes);
            written += len;
            self.ready_bytes -= len;
            self.ready.pop_front();
        }
        (written, self.refill())
    }

    /// Remove every undrained submit record of `context` (the host never saw
    /// them). Returns each one's `(seqno, parked)` and whether a record the
    /// freed room admitted has a parked submitter.
    pub fn drop_submits(&mut self, context: u32) -> (Vec<(u64, bool)>, bool) {
        let mut dropped = Vec::new();
        let mut keep = |record: &Record, bytes: Option<&mut usize>| match record.submit {
            Some(seqno) if record.context == context => {
                dropped.push((seqno, record.parked));
                if let Some(bytes) = bytes {
                    *bytes -= record.bytes.len();
                }
                false
            }
            _ => true,
        };
        let mut ready_bytes = self.ready_bytes;
        self.ready.retain(|r| keep(r, Some(&mut ready_bytes)));
        self.ready_bytes = ready_bytes;
        self.backlog.retain(|r| keep(r, None));
        let admitted = self.refill();
        (dropped, admitted)
    }

    fn refill(&mut self) -> bool {
        let mut parked = false;
        while let Some(front) = self.backlog.front() {
            let len = front.bytes.len();
            if self.ready_bytes + len > OUTBOX_CAPACITY {
                break;
            }
            let record = self.backlog.pop_front().expect("front exists");
            parked |= record.parked;
            self.ready_bytes += len;
            self.ready.push_back(record);
        }
        parked
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn record(len: usize, fill: u8, submit: Option<u64>) -> Record {
        Record {
            bytes: vec![fill; len],
            context: 1,
            submit,
            parked: false,
        }
    }

    #[test]
    fn drain_copies_whole_records_only_and_admits_the_backlog_in_order() {
        let mut outbox = Outbox::new();
        assert!(outbox.push(record(OUTBOX_CAPACITY - 8, 1, Some(1))));
        assert!(!outbox.push(record(16, 2, Some(2))), "does not fit");
        assert!(
            !outbox.push(record(4, 3, Some(3))),
            "order is kept behind the backlog"
        );
        outbox.mark_parked(2);
        assert!(outbox.holds_in_backlog(2));
        let mut small = vec![0u8; 64];
        assert_eq!(
            outbox.drain(&mut small),
            (0, false),
            "the first record does not fit"
        );
        let mut out = vec![0u8; OUTBOX_CAPACITY];
        let (written, parked) = outbox.drain(&mut out);
        assert_eq!(written, OUTBOX_CAPACITY - 8);
        assert!(parked, "the parked submitter's record was admitted");
        assert!(!outbox.holds_in_backlog(2));
        assert_eq!(outbox.drain(&mut out), (20, false));
        assert_eq!(&out[..16], &[2u8; 16]);
        assert_eq!(&out[16..20], &[3u8; 4]);
    }
}
