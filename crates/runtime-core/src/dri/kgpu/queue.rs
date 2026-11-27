//! The GPU device's FIFO of encoded submission records.
//!
//! Ownership: the GPU device (`super`) is the only producer; the host GPU
//! adapter is the only consumer, through `KgpuDevice::drain_outbox`. The
//! kernel never waits on the consumer, so the outbox is bounded in bytes.
//!
//! A guest op that would queue a record checks for room first and, without
//! room, commits nothing and answers `EAGAIN`; the host re-executes the whole
//! request later (Ruling R13), so the committing execution writes its outputs
//! through the ordinary output path. Only the destroy records that exit and
//! exec cleanup queue have no caller to send back; those wait in a backlog
//! behind the outbox, in order. The backlog is bounded by the context limit,
//! since each such record removes a context.

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

    /// Whether the outbox holds no drainable record. Records wait in the
    /// backlog only behind a non-empty outbox, so this covers the backlog.
    pub fn is_empty(&self) -> bool {
        self.ready.is_empty()
    }

    /// Whether a record of `len` bytes would go straight to the outbox.
    pub fn fits(&self, len: usize) -> bool {
        self.backlog.is_empty() && self.ready_bytes + len <= OUTBOX_CAPACITY
    }

    /// Queue a record; returns whether it went straight to the outbox. A
    /// nonempty backlog takes every new record, so order is preserved.
    pub fn push(&mut self, record: Record) -> bool {
        let len = record.bytes.len();
        if self.fits(len) {
            self.ready_bytes += len;
            self.ready.push_back(record);
            true
        } else {
            self.backlog.push_back(record);
            false
        }
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
    /// admit backlog records into the freed room. Returns the bytes written.
    pub fn drain(&mut self, out: &mut [u8]) -> usize {
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
        self.refill();
        written
    }

    /// Remove every undrained submit record of `context` (the host never saw
    /// them) and return their sequence numbers.
    pub fn drop_submits(&mut self, context: u32) -> Vec<u64> {
        let mut dropped = Vec::new();
        let mut ready_bytes = self.ready_bytes;
        self.ready.retain(|r| match r.submit {
            Some(seqno) if r.context == context => {
                dropped.push(seqno);
                ready_bytes -= r.bytes.len();
                false
            }
            _ => true,
        });
        self.ready_bytes = ready_bytes;
        self.refill();
        dropped
    }

    fn refill(&mut self) {
        while let Some(front) = self.backlog.front() {
            let len = front.bytes.len();
            if self.ready_bytes + len > OUTBOX_CAPACITY {
                break;
            }
            let record = self.backlog.pop_front().expect("front exists");
            self.ready_bytes += len;
            self.ready.push_back(record);
        }
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
        }
    }

    #[test]
    fn drain_copies_whole_records_only_and_admits_the_backlog_in_order() {
        let mut outbox = Outbox::new();
        assert!(outbox.push(record(OUTBOX_CAPACITY - 8, 1, Some(1))));
        assert!(!outbox.fits(16));
        assert!(!outbox.push(record(16, 2, None)), "does not fit");
        assert!(!outbox.fits(4), "nothing passes the backlog");
        assert!(
            !outbox.push(record(4, 3, None)),
            "order is kept behind the backlog"
        );
        let mut small = vec![0u8; 64];
        assert_eq!(outbox.drain(&mut small), 0, "the first record does not fit");
        let mut out = vec![0u8; OUTBOX_CAPACITY];
        assert_eq!(outbox.drain(&mut out), OUTBOX_CAPACITY - 8);
        assert_eq!(outbox.drain(&mut out), 20);
        assert_eq!(&out[..16], &[2u8; 16]);
        assert_eq!(&out[16..20], &[3u8; 4]);
        assert!(outbox.fits(OUTBOX_CAPACITY));
    }
}
