//! The kernel GPU device behind `kandelo.kgpu.v1`.
//!
//! Ownership: the process table owns the one `KgpuDevice`. The kernel owns
//! GPU contexts, assigns submission sequence numbers, translates and pins the
//! guest ranges a submission names, queues encoded records for the host GPU
//! adapter to drain, consumes the adapter's completion records, and parks and
//! wakes guest threads waiting on a sequence number. The host only transports
//! records and runs the executor; every decision a guest can observe -- which
//! frames the device may touch and until when, what a wait returns and when
//! -- is made here, once, for every host.
//!
//! WHY the kernel and not the host: a submission names guest virtual ranges,
//! and only the memory-group storage owner knows which backing frames those
//! name and when the frames may be reused. Translation and pinning happen in
//! one synchronous kernel entry (`MemoryGroups::device_translate_and_pin`),
//! and only a `Retired` completion releases the pins, so the executor never
//! reads or writes a frame the guest has since given back.
//!
//! The kernel validates only a stream's header (magic and version), never its
//! records: the executor reads the stream once into its own memory and
//! treats it as hostile there.
//!
//! Grouped programs only: the executor reaches guest memory through the
//! group's shared backing, which a process outside a memory group does not
//! have, so every op from such a process fails with `EOPNOTSUPP`.

extern crate alloc;

mod context;
mod queue;
mod wait;

pub use queue::OUTBOX_CAPACITY;
pub use wait::{KgpuPark, is_kgpu_source};

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::mem::offset_of;

use kgpu_stream::{KGPU_STREAM_MAGIC, KGPU_STREAM_VERSION, STREAM_HEADER_SIZE};
use wasm_posix_shared::Errno;
use wasm_posix_shared::kgpu::{
    self as abi, BufferSpec, Completion, CompletionKind, KgpuBuffer, KgpuContextCreate,
    KgpuContextDestroy, KgpuSubmit, KgpuWait, SubmissionHeader, SubmissionKind, op_arg_size,
};
use wasm_posix_shared::memory_group::ReceiptRecord;

use crate::memory_group::MemoryGroups;
use crate::memory_group::storage::{DevicePinId, DeviceRange};
use crate::process::HostIO;
use crate::process_table::ProcessTable;
use crate::syscalls::ParkOutcome;
use crate::wait_park::Resume;
use crate::wait_queue::{WaitKind, WakeSource};

use context::Contexts;
use queue::{Outbox, Record};

/// The one device's identity in wake sources.
const DEVICE: u32 = 0;

/// A submission the executor has not retired: its frames stay pinned.
struct InFlight {
    context: u32,
    /// The memory group whose storage issued `pin`.
    group: u32,
    pin: DevicePinId,
}

pub struct KgpuDevice {
    renderer_available: bool,
    contexts: Contexts,
    queue: Outbox,
    /// Every committed, unretired submission by sequence number, whether
    /// still queued or already drained.
    in_flight: BTreeMap<u64, InFlight>,
    next_seqno: u64,
    /// Held submissions whose records were dropped because their context was
    /// lost; their parked submitters answer `EIO` at the next settle.
    dropped: Vec<u64>,
}

impl Default for KgpuDevice {
    fn default() -> Self {
        Self::new()
    }
}

impl KgpuDevice {
    pub const fn new() -> Self {
        Self {
            renderer_available: false,
            contexts: Contexts::new(),
            queue: Outbox::new(),
            in_flight: BTreeMap::new(),
            next_seqno: 1,
            dropped: Vec::new(),
        }
    }

    /// Whether the host can render. Without a renderer, context creation
    /// fails with `ENODEV` rather than appearing to succeed.
    pub fn set_renderer_available(&mut self, available: bool) {
        self.renderer_available = available;
    }

    /// Copy whole queued records into `out`; returns the bytes written. A
    /// buffer of `OUTBOX_CAPACITY` bytes always takes at least one record.
    /// Room the drain frees admits backlog records, and a submitter parked
    /// behind one of them is re-decided at the next settle.
    pub fn drain_outbox(&mut self, out: &mut [u8]) -> usize {
        let (written, admitted_parked) = self.queue.drain(out);
        if admitted_parked {
            note(WakeSource::KgpuOutbox { device: DEVICE });
        }
        written
    }

    /// Apply the executor's completion records (`wasm_posix_shared::kgpu`
    /// completion wire), whole or not at all: every record is decoded and
    /// checked before any applies, so a malformed batch changes nothing.
    ///
    /// - `Retired` retires every submission of its context at or below its
    ///   sequence number (an executor runs a context's work in order),
    ///   releases their pins and advances the context's `last_retired`.
    /// - `ContextLost` marks the context lost. Submissions the host has not
    ///   drained are dropped and unpinned, since the executor never saw
    ///   them; drained ones stay pinned until a `Retired` covers them.
    /// - `ContextReady` acknowledges a create and changes nothing (R4).
    ///
    /// Each wakes the parked waiters it concerns through the parking
    /// owner's dirty-source set; `ProcessTable::kgpu_settle` decides them.
    pub fn complete(&mut self, groups: &mut MemoryGroups, records: &[u8]) -> Result<(), Errno> {
        if records.len() % abi::COMPLETION_SIZE != 0 {
            return Err(Errno::EINVAL);
        }
        let mut batch = Vec::new();
        batch
            .try_reserve(records.len() / abi::COMPLETION_SIZE)
            .map_err(|_| Errno::ENOMEM)?;
        for bytes in records.chunks_exact(abi::COMPLETION_SIZE) {
            let record = abi::decode_completion(bytes).map_err(|_| Errno::EINVAL)?;
            if record.kind == CompletionKind::Retired
                && (record.seqno >= self.next_seqno
                    || self
                        .queue
                        .holds_submit_through(record.context, record.seqno))
            {
                // A sequence number never assigned, or work the host has
                // not drained: the host cannot have retired it.
                return Err(Errno::EINVAL);
            }
            batch.push(record);
        }
        for record in batch {
            match record.kind {
                CompletionKind::Retired => self.retire(groups, record),
                CompletionKind::ContextLost => self.lose(groups, record.context),
                CompletionKind::ContextReady => {}
            }
        }
        Ok(())
    }

    fn retire(&mut self, groups: &mut MemoryGroups, record: Completion) {
        let retired: Vec<u64> = self
            .in_flight
            .range(..=record.seqno)
            .filter(|(_, work)| work.context == record.context)
            .map(|(seqno, _)| *seqno)
            .collect();
        for seqno in retired {
            if let Some(work) = self.in_flight.remove(&seqno) {
                groups.device_unpin(work.group, work.pin);
            }
        }
        // The context may be gone (destroyed, or its process exited); its
        // pins still had to be released above.
        if let Some(context) = self.contexts.get_mut(record.context) {
            context.last_retired = context.last_retired.max(record.seqno);
        }
        note(WakeSource::KgpuSeqno {
            device: DEVICE,
            context: record.context,
            seqno: record.seqno,
        });
    }

    fn lose(&mut self, groups: &mut MemoryGroups, id: u32) {
        let Some(context) = self.contexts.get_mut(id) else {
            return;
        };
        context.lost = true;
        let (dropped, admitted_parked) = self.queue.drop_submits(id);
        let mut dropped_parked = false;
        for (seqno, parked) in dropped {
            if let Some(work) = self.in_flight.remove(&seqno) {
                groups.device_unpin(work.group, work.pin);
            }
            if parked {
                self.dropped.push(seqno);
                dropped_parked = true;
            }
        }
        note(WakeSource::KgpuSeqno {
            device: DEVICE,
            context: id,
            seqno: u64::MAX,
        });
        if dropped_parked || admitted_parked {
            note(WakeSource::KgpuOutbox { device: DEVICE });
        }
    }

    /// What a wait for `seqno` on context `id` answers now, or `None` while
    /// it is still pending. Work that retired before a loss still succeeds.
    fn decide_wait(&self, id: u32, seqno: u64) -> Option<Result<(), Errno>> {
        let Some(context) = self.contexts.get(id) else {
            return Some(Err(Errno::ENOENT));
        };
        if seqno <= context.last_retired {
            return Some(Ok(()));
        }
        if context.lost {
            return Some(Err(Errno::EIO));
        }
        // Retirement only advances through this context's own submissions;
        // a number above all of them would never be reached.
        if !self
            .in_flight
            .range(seqno..)
            .any(|(_, work)| work.context == id)
        {
            return Some(Err(Errno::EINVAL));
        }
        None
    }

    /// What a parked submission answers now, or `None` while its record
    /// still waits in the backlog.
    fn decide_submit(&self, seqno: u64) -> Option<Result<(), Errno>> {
        if self.queue.holds_in_backlog(seqno) {
            None
        } else if self.dropped.contains(&seqno) {
            Some(Err(Errno::EIO))
        } else {
            Some(Ok(()))
        }
    }

    /// Queue a control record (create or destroy) for `context`.
    fn queue_control(&mut self, kind: SubmissionKind, context: u32) -> Result<(), Errno> {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(abi::SUBMISSION_HEADER_SIZE)
            .map_err(|_| Errno::ENOMEM)?;
        bytes.resize(abi::SUBMISSION_HEADER_SIZE, 0);
        abi::encode_submission(
            &mut bytes,
            &SubmissionHeader {
                kind,
                context,
                seqno: 0,
            },
            &[],
            &[],
        )
        .map_err(|_| Errno::EINVAL)?;
        self.queue.reserve()?;
        self.queue.push(Record {
            bytes,
            context,
            submit: None,
            parked: false,
        });
        Ok(())
    }

    /// Destroy every context `pid` owns: its image is gone.
    fn retire_process(&mut self, pid: u32) -> Result<(), Errno> {
        for id in self.contexts.owned_by(pid) {
            self.queue_control(SubmissionKind::ContextDestroy, id)?;
            self.contexts.remove(id);
            note(WakeSource::KgpuSeqno {
                device: DEVICE,
                context: id,
                seqno: u64::MAX,
            });
        }
        Ok(())
    }

    fn create(&mut self, pid: u32, arg: &mut [u8]) -> Result<ParkOutcome, Errno> {
        if u32_at(arg, offset_of!(KgpuContextCreate, flags)) != 0 {
            return Err(Errno::EINVAL);
        }
        if !self.renderer_available {
            return Err(Errno::ENODEV);
        }
        let id = self.contexts.create(pid)?;
        if let Err(error) = self.queue_control(SubmissionKind::ContextCreate, id) {
            self.contexts.remove(id);
            return Err(error);
        }
        put_u32(arg, offset_of!(KgpuContextCreate, context), id);
        Ok(ParkOutcome::Done(0))
    }

    /// Valid only for the owner. The destroy record follows the context's
    /// queued work, so the executor runs that work first. A sibling thread
    /// waiting on the context is answered `ENOENT`.
    fn destroy(&mut self, pid: u32, arg: &[u8]) -> Result<ParkOutcome, Errno> {
        let id = u32_at(arg, offset_of!(KgpuContextDestroy, context));
        if u32_at(arg, offset_of!(KgpuContextDestroy, pad)) != 0 {
            return Err(Errno::EINVAL);
        }
        self.contexts.owned(id, pid)?;
        self.queue_control(SubmissionKind::ContextDestroy, id)?;
        self.contexts.remove(id);
        note(WakeSource::KgpuSeqno {
            device: DEVICE,
            context: id,
            seqno: u64::MAX,
        });
        Ok(ParkOutcome::Done(0))
    }

    fn submit(
        &mut self,
        groups: &mut MemoryGroups,
        host: &mut dyn HostIO,
        caller: ReceiptRecord,
        pid: u32,
        tid: u32,
        arg: &mut [u8],
    ) -> Result<ParkOutcome, Errno> {
        let id = u32_at(arg, offset_of!(KgpuSubmit, context));
        let stream_addr = u64_at(arg, offset_of!(KgpuSubmit, stream_addr));
        let stream_len = u32_at(arg, offset_of!(KgpuSubmit, stream_len));
        let buffer_count = u32_at(arg, offset_of!(KgpuSubmit, buffer_count));
        let buffers_addr = u64_at(arg, offset_of!(KgpuSubmit, buffers_addr));
        if u32_at(arg, offset_of!(KgpuSubmit, flags)) != 0 {
            return Err(Errno::EINVAL);
        }
        if self.contexts.owned(id, pid)?.lost {
            return Err(Errno::EIO);
        }
        if (stream_len as usize) < STREAM_HEADER_SIZE
            || stream_len > abi::KGPU_MAX_STREAM
            || buffer_count > abi::KGPU_MAX_BUFFERS
        {
            return Err(Errno::EINVAL);
        }

        // Read once: the header and the buffer table are copied into kernel
        // memory and only those copies are checked and used.
        let mut header = [0u8; STREAM_HEADER_SIZE];
        groups.device_read(caller, stream_addr, &mut header, host)?;
        if u32_at(&header, 0) != KGPU_STREAM_MAGIC
            || u16::from_le_bytes([header[4], header[5]]) != KGPU_STREAM_VERSION
        {
            return Err(Errno::EINVAL);
        }
        const ENTRY: usize = core::mem::size_of::<KgpuBuffer>();
        let mut table = Vec::new();
        table
            .try_reserve_exact(buffer_count as usize * ENTRY)
            .map_err(|_| Errno::ENOMEM)?;
        table.resize(buffer_count as usize * ENTRY, 0);
        if buffer_count != 0 {
            groups.device_read(caller, buffers_addr, &mut table, host)?;
        }
        let mut ranges = Vec::new();
        ranges
            .try_reserve_exact(1 + buffer_count as usize)
            .map_err(|_| Errno::ENOMEM)?;
        ranges.push(DeviceRange {
            addr: stream_addr,
            len: stream_len,
            write: false,
        });
        let mut access = Vec::new();
        access
            .try_reserve_exact(buffer_count as usize)
            .map_err(|_| Errno::ENOMEM)?;
        for entry in table.chunks_exact(ENTRY) {
            let mode = u32_at(entry, offset_of!(KgpuBuffer, access));
            if mode == 0 || mode & !(abi::KGPU_ACCESS_READ | abi::KGPU_ACCESS_WRITE) != 0 {
                return Err(Errno::EINVAL);
            }
            access.push(mode);
            ranges.push(DeviceRange {
                addr: u64_at(entry, offset_of!(KgpuBuffer, addr)),
                len: u32_at(entry, offset_of!(KgpuBuffer, len)),
                write: mode & abi::KGPU_ACCESS_WRITE != 0,
            });
        }
        let seqno = self.next_seqno;
        let next = seqno.checked_add(1).ok_or(Errno::EOVERFLOW)?;

        let (extents, pin) = groups.device_translate_and_pin(caller, &ranges, host)?;
        // Everything after the pin either commits or releases it.
        let queued = self.encode_and_queue(id, seqno, &extents, &access);
        let admitted = match queued {
            Ok(admitted) => admitted,
            Err(error) => {
                groups.device_unpin(caller.group, pin);
                return Err(error);
            }
        };
        self.in_flight.insert(
            seqno,
            InFlight {
                context: id,
                group: caller.group,
                pin,
            },
        );
        self.next_seqno = next;
        put_u64(arg, offset_of!(KgpuSubmit, seqno), seqno);
        if admitted {
            return Ok(ParkOutcome::Done(0));
        }
        let park = KgpuPark::Submit {
            device: DEVICE,
            seqno,
        };
        let parked = crate::wait_park::with(|parks| {
            parks.park(
                pid,
                tid,
                WaitKind::Kgpu,
                alloc::vec![park.source()],
                None,
                Resume::Kgpu(park),
            )
        });
        match parked {
            Ok(generation) => {
                self.queue.mark_parked(seqno);
                Ok(ParkOutcome::Parked(generation))
            }
            // The submission is committed; only this one instance of
            // backpressure is lost.
            Err(_) => Ok(ParkOutcome::Done(0)),
        }
    }

    /// Encode a submit record and queue it; returns whether it went straight
    /// to the outbox. Fails, queuing nothing, if the record cannot fit the
    /// outbox at all (`E2BIG`): it could never be drained.
    fn encode_and_queue(
        &mut self,
        context: u32,
        seqno: u64,
        extents: &[Vec<abi::Extent>],
        access: &[u32],
    ) -> Result<bool, Errno> {
        let (stream, buffers) = extents.split_first().ok_or(Errno::EINVAL)?;
        let size = abi::SUBMISSION_HEADER_SIZE
            + stream.len() * abi::EXTENT_SIZE
            + buffers
                .iter()
                .map(|b| abi::BUFFER_HEADER_SIZE + b.len() * abi::EXTENT_SIZE)
                .sum::<usize>();
        if size > OUTBOX_CAPACITY {
            return Err(Errno::E2BIG);
        }
        let mut specs = Vec::new();
        specs
            .try_reserve_exact(buffers.len())
            .map_err(|_| Errno::ENOMEM)?;
        for (extents, access) in buffers.iter().zip(access) {
            specs.push(BufferSpec {
                access: *access,
                extents,
            });
        }
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(size).map_err(|_| Errno::ENOMEM)?;
        bytes.resize(size, 0);
        let header = SubmissionHeader {
            kind: SubmissionKind::Submit,
            context,
            seqno,
        };
        abi::encode_submission(&mut bytes, &header, stream, &specs).map_err(
            |error| match error {
                abi::RecordError::TooMany => Errno::E2BIG,
                _ => Errno::EINVAL,
            },
        )?;
        self.queue.reserve()?;
        Ok(self.queue.push(Record {
            bytes,
            context,
            submit: Some(seqno),
            parked: false,
        }))
    }

    fn wait(
        &mut self,
        host: &mut dyn HostIO,
        pid: u32,
        tid: u32,
        arg: &[u8],
    ) -> Result<ParkOutcome, Errno> {
        let id = u32_at(arg, offset_of!(KgpuWait, context));
        let seqno = u64_at(arg, offset_of!(KgpuWait, seqno));
        let timeout_ns = u64_at(arg, offset_of!(KgpuWait, timeout_ns)) as i64;
        if u32_at(arg, offset_of!(KgpuWait, flags)) != 0 {
            return Err(Errno::EINVAL);
        }
        self.contexts.owned(id, pid)?;
        if let Some(decided) = self.decide_wait(id, seqno) {
            return decided.map(|()| ParkOutcome::Done(0));
        }
        if timeout_ns == 0 {
            return Err(Errno::ETIME);
        }
        let deadline = if timeout_ns < 0 {
            None
        } else {
            Some(crate::wait_park::now_ns(host)?.saturating_add(timeout_ns))
        };
        let park = KgpuPark::Wait {
            device: DEVICE,
            context: id,
            seqno,
        };
        let generation = crate::wait_park::with(|parks| {
            parks.park(
                pid,
                tid,
                WaitKind::Kgpu,
                alloc::vec![park.source()],
                deadline,
                Resume::Kgpu(park),
            )
        })?;
        Ok(ParkOutcome::Parked(generation))
    }
}

fn note(source: WakeSource) {
    crate::wait_park::with(|parks| parks.note_source_ready(source));
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"))
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8 bytes"))
}

fn put_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

impl ProcessTable {
    /// `kandelo.kgpu.v1`: one op from task `(pid, tid)` with its staged
    /// argument struct, which the op may update in place.
    ///
    /// The argument size must be exactly the op's struct size (R11): the
    /// kernel's check is authoritative whatever the import prechecked.
    pub fn kgpu_request(
        &mut self,
        host: &mut dyn HostIO,
        pid: u32,
        tid: u32,
        op: i32,
        arg: &mut [u8],
    ) -> Result<ParkOutcome, Errno> {
        if op_arg_size(op) != Some(arg.len()) {
            return Err(Errno::EINVAL);
        }
        self.kgpu_apply_retirements();
        let caller = self
            .memory_group_task(pid, tid)?
            .ok_or(Errno::EOPNOTSUPP)?
            .record();
        let (device, groups) = self.kgpu_parts();
        match op {
            abi::KGPU_OP_CONTEXT_CREATE => device.create(pid, arg),
            abi::KGPU_OP_CONTEXT_DESTROY => device.destroy(pid, arg),
            abi::KGPU_OP_SUBMIT => device.submit(groups, host, caller, pid, tid, arg),
            _ => device.wait(host, pid, tid, arg),
        }
    }

    /// Apply completion records the host GPU adapter delivered.
    pub fn kgpu_complete(&mut self, records: &[u8]) -> Result<(), Errno> {
        self.kgpu_apply_retirements();
        let (device, groups) = self.kgpu_parts();
        device.complete(groups, records)
    }

    /// Re-decide the parked kgpu calls a fired kgpu source concerns, and
    /// destroy the contexts of processes whose image is gone. The kernel
    /// runs this with its other settle passes; decisions reach the guest
    /// through the parking owner's ordinary completion queue, which grouped
    /// tasks publish through `group_completion` like every other park.
    pub fn kgpu_settle(&mut self) {
        self.kgpu_apply_retirements();
        let waiters = crate::wait_park::with(|parks| parks.take_dirty_kgpu_waiters());
        let device = self.kgpu_parts().0;
        for (id, _pid, _tid, park) in waiters {
            let value = match park {
                KgpuPark::Wait { context, seqno, .. } => device.decide_wait(context, seqno),
                KgpuPark::Submit { seqno, .. } => device.decide_submit(seqno),
            };
            if let Some(decided) = value {
                let value = decided.map_or_else(|error| -(error as i32), |()| 0);
                crate::wait_park::with(|parks| parks.finish_kgpu_waiter(id, park, value));
            }
        }
        // Every parked submitter a drop concerned was offered above (a drop
        // fires the outbox source, which concerns them all).
        device.dropped.clear();
    }

    fn kgpu_apply_retirements(&mut self) {
        let pids = take_retired_processes();
        let mut pending = pids.iter();
        while let Some(&pid) = pending.next() {
            if self.kgpu_parts().0.retire_process(pid).is_err() {
                // Out of memory for a destroy record: keep the rest for the
                // next entry rather than losing a destroy.
                for &pid in core::iter::once(&pid).chain(pending) {
                    note_process_retired(pid);
                }
                return;
            }
        }
    }
}

/// The process image `pid` is gone (exit, exec, removal). Called from
/// `wait_park::retire_process`, next to the DRM cleanup, where no process
/// table is in hand; the device destroys that process's contexts at its next
/// entry (every kgpu op and every settle), so no new context of a successor
/// image can be created first.
pub(crate) fn note_process_retired(pid: u32) {
    with_retired(|pids| {
        if !pids.contains(&pid) {
            pids.push(pid);
        }
    });
}

fn take_retired_processes() -> Vec<u32> {
    with_retired(|pids| {
        if pids.is_empty() {
            Vec::new()
        } else {
            core::mem::take(pids)
        }
    })
}

#[cfg(not(test))]
struct RetiredGlobal(core::cell::UnsafeCell<Vec<u32>>);

#[cfg(not(test))]
// SAFETY: the kernel is entered by one host thread at a time (the same
// serialization `wait_park` relies on), and no reference escapes
// `with_retired`.
unsafe impl Sync for RetiredGlobal {}

#[cfg(not(test))]
static RETIRED: RetiredGlobal = RetiredGlobal(core::cell::UnsafeCell::new(Vec::new()));

// Native unit tests run in parallel; give each its own list, as `wait_park`
// does for its parks.
#[cfg(test)]
std::thread_local! {
    static TEST_RETIRED: core::cell::RefCell<Vec<u32>> = const { core::cell::RefCell::new(Vec::new()) };
}

fn with_retired<R>(f: impl FnOnce(&mut Vec<u32>) -> R) -> R {
    #[cfg(test)]
    {
        return TEST_RETIRED.with(|pids| f(&mut pids.borrow_mut()));
    }
    #[cfg(not(test))]
    f(unsafe { &mut *RETIRED.0.get() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_group::physical::{HostMemory, PhysicalMemory};
    use crate::memory_group::{ImageLayout, MemoryGroupId, MemoryGroupLimits};
    use crate::wait_park::Completion as Decision;
    use alloc::vec;
    use wasm_posix_shared::kgpu::{
        Extent, KGPU_ACCESS_READ, KGPU_ACCESS_WRITE, KGPU_OP_CONTEXT_CREATE as CREATE,
        KGPU_OP_CONTEXT_DESTROY as DESTROY, KGPU_OP_SUBMIT as SUBMIT, KGPU_OP_WAIT as WAIT,
        decode_submission, encode_completion,
    };
    use wasm_posix_shared::memory_group::{ReceiptRecord, TaskAction};
    use wasm_posix_shared::program_extensions::memory_group_v3 as layout;

    mod stream {
        pub use kgpu_stream::{KGPU_STREAM_MAGIC as MAGIC, KGPU_STREAM_VERSION as VERSION};
    }

    const PAGE: u32 = layout::PAGE_BYTES;
    const STREAM: u32 = PAGE + 0x100;
    const TABLE: u32 = PAGE + 0x1000;
    const DATA: u32 = 2 * PAGE + 0x40;

    struct Fixture<H: HostIO> {
        table: ProcessTable,
        host: H,
        group: MemoryGroupId,
        pid: u32,
        record: ReceiptRecord,
    }

    fn admit<H: HostIO>(
        table: &mut ProcessTable,
        host: &mut H,
        group: MemoryGroupId,
        pid: u32,
    ) -> ReceiptRecord {
        let admission = table.prepare_process_memory_group(group, pid).unwrap();
        table
            .memory_groups()
            .prepare_storage_image(
                admission,
                ImageLayout {
                    initial_pages: 4,
                    maximum_pages: 16,
                    scratch_bytes: PAGE,
                },
                host,
            )
            .unwrap();
        table
            .memory_group_task_action(admission.record(), TaskAction::Start)
            .unwrap();
        table.memory_groups().publish_storage(admission).unwrap();
        admission.record()
    }

    fn grouped() -> Fixture<impl HostIO> {
        let mut table = ProcessTable::new();
        let pid = table.create_process().unwrap();
        table.memory_groups().configure(64, 1).unwrap();
        let group = table
            .memory_groups()
            .create(MemoryGroupLimits {
                maximum_pages: 64,
                maximum_processes: 4,
                maximum_tasks: 8,
            })
            .unwrap();
        let mut host = crate::exec_control::tests::storage_host();
        table
            .memory_groups()
            .create_storage(group, 1, &mut host)
            .unwrap();
        let record = admit(&mut table, &mut host, group, pid);
        table.kgpu_parts().0.set_renderer_available(true);
        let mut f = Fixture {
            table,
            host,
            group,
            pid,
            record,
        };
        f.write_stream(stream::MAGIC, stream::VERSION);
        f
    }

    impl<H: HostIO> Fixture<H> {
        fn request(&mut self, op: i32, arg: &mut [u8]) -> Result<ParkOutcome, Errno> {
            self.table
                .kgpu_request(&mut self.host, self.pid, self.pid, op, arg)
        }

        fn poke(&mut self, addr: u32, bytes: &[u8]) {
            let (store, admission) = self
                .table
                .memory_groups()
                .storage_owner(self.record)
                .unwrap();
            let mut memory = HostMemory {
                resource: store.resource(),
                host: &mut self.host,
            };
            for (i, chunk) in bytes.chunks(4).enumerate() {
                let mut word = [0u8; 4];
                word[..chunk.len()].copy_from_slice(chunk);
                store
                    .write_execution_word(
                        &mut memory,
                        admission,
                        addr + 4 * i as u32,
                        u32::from_le_bytes(word),
                    )
                    .unwrap();
            }
        }

        fn write_stream(&mut self, magic: u32, version: u16) {
            let mut header = [0u8; 16];
            header[0..4].copy_from_slice(&magic.to_le_bytes());
            header[4..6].copy_from_slice(&version.to_le_bytes());
            self.poke(STREAM, &header);
        }

        fn write_buffers(&mut self, buffers: &[KgpuBuffer]) {
            let mut bytes = Vec::new();
            for b in buffers {
                bytes.extend_from_slice(&b.addr.to_le_bytes());
                bytes.extend_from_slice(&b.len.to_le_bytes());
                bytes.extend_from_slice(&b.access.to_le_bytes());
            }
            self.poke(TABLE, &bytes);
        }

        /// Translation computed independently of the device, from the
        /// image's own page table.
        fn extents(&mut self, addr: u32, len: u32) -> Vec<Extent> {
            let (store, admission) = self
                .table
                .memory_groups()
                .storage_owner(self.record)
                .unwrap();
            let root = store.descriptor(admission).unwrap().root;
            let memory = HostMemory {
                resource: store.resource(),
                host: &mut self.host,
            };
            let mut out: Vec<Extent> = Vec::new();
            let mut cursor = addr;
            while cursor < addr + len {
                let within = cursor % PAGE;
                let span = (PAGE - within).min(addr + len - cursor);
                let pte = memory
                    .atomic_load(root + layout::ROOT_HEADER_BYTES + cursor / PAGE * 4)
                    .unwrap();
                let offset = u64::from(pte & 0xffff_0000) + u64::from(within);
                match out.last_mut() {
                    Some(last) if last.offset + u64::from(last.len) == offset => last.len += span,
                    _ => out.push(Extent {
                        offset,
                        len: span,
                        pad: 0,
                    }),
                }
                cursor += span;
            }
            out
        }

        fn pinned(&mut self) -> usize {
            self.table
                .memory_groups()
                .device_pinned_frames(self.group)
                .unwrap()
        }

        fn drain(&mut self) -> Vec<u8> {
            let mut out = vec![0u8; OUTBOX_CAPACITY];
            let n = self.table.kgpu_parts().0.drain_outbox(&mut out);
            out.truncate(n);
            out
        }

        fn create(&mut self) -> u32 {
            let mut arg = create_arg();
            assert_eq!(self.request(CREATE, &mut arg), Ok(ParkOutcome::Done(0)));
            u32::from_le_bytes(arg[4..8].try_into().unwrap())
        }

        fn submit(&mut self, context: u32, buffers: u32) -> (Result<ParkOutcome, Errno>, u64) {
            let mut arg = submit_arg(context, 16, buffers);
            let result = self.request(SUBMIT, &mut arg);
            (result, u64::from_le_bytes(arg[32..40].try_into().unwrap()))
        }

        fn complete(
            &mut self,
            kind: CompletionKind,
            context: u32,
            seqno: u64,
        ) -> Result<(), Errno> {
            let mut bytes = [0u8; abi::COMPLETION_SIZE];
            encode_completion(
                &mut bytes,
                &Completion {
                    kind,
                    context,
                    seqno,
                    status: 0,
                },
            )
            .unwrap();
            let result = self.table.kgpu_complete(&bytes);
            self.table.kgpu_settle();
            result
        }
    }

    fn create_arg() -> Vec<u8> {
        vec![0u8; core::mem::size_of::<KgpuContextCreate>()]
    }

    fn submit_arg(context: u32, stream_len: u32, buffers: u32) -> Vec<u8> {
        let mut arg = vec![0u8; core::mem::size_of::<KgpuSubmit>()];
        arg[0..4].copy_from_slice(&context.to_le_bytes());
        arg[8..16].copy_from_slice(&u64::from(STREAM).to_le_bytes());
        arg[16..20].copy_from_slice(&stream_len.to_le_bytes());
        arg[20..24].copy_from_slice(&buffers.to_le_bytes());
        arg[24..32].copy_from_slice(&u64::from(TABLE).to_le_bytes());
        arg
    }

    fn wait_arg(context: u32, seqno: u64, timeout_ns: i64) -> Vec<u8> {
        let mut arg = vec![0u8; core::mem::size_of::<KgpuWait>()];
        arg[0..4].copy_from_slice(&context.to_le_bytes());
        arg[8..16].copy_from_slice(&seqno.to_le_bytes());
        arg[16..24].copy_from_slice(&timeout_ns.to_le_bytes());
        arg
    }

    fn destroy_arg(context: u32) -> Vec<u8> {
        let mut arg = vec![0u8; core::mem::size_of::<KgpuContextDestroy>()];
        arg[0..4].copy_from_slice(&context.to_le_bytes());
        arg
    }

    fn decisions() -> Vec<Decision> {
        crate::wait_park::with(|parks| parks.take_completions())
    }

    fn parked(result: Result<ParkOutcome, Errno>) -> u64 {
        match result {
            Ok(ParkOutcome::Parked(generation)) => generation,
            other => panic!("expected a park, got {other:?}"),
        }
    }

    /// Every record in `bytes`, in order, as (kind, context, seqno).
    fn records(bytes: &[u8]) -> Vec<(SubmissionKind, u32, u64)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let view = decode_submission(&bytes[at..]).unwrap();
            out.push((view.header.kind, view.header.context, view.header.seqno));
            at += view.encoded_len;
        }
        out
    }

    #[test]
    fn argument_layouts_match_the_parsers() {
        assert_eq!(offset_of!(KgpuContextCreate, context), 4);
        assert_eq!(offset_of!(KgpuSubmit, stream_addr), 8);
        assert_eq!(offset_of!(KgpuSubmit, buffers_addr), 24);
        assert_eq!(offset_of!(KgpuSubmit, seqno), 32);
        assert_eq!(offset_of!(KgpuWait, timeout_ns), 16);
    }

    #[test]
    fn bad_op_or_size_is_einval() {
        let mut f = grouped();
        let mut arg = create_arg();
        assert_eq!(f.request(0, &mut arg), Err(Errno::EINVAL));
        assert_eq!(f.request(5, &mut arg), Err(Errno::EINVAL));
        assert_eq!(f.request(SUBMIT, &mut arg), Err(Errno::EINVAL));
        let mut long = vec![0u8; 9];
        assert_eq!(f.request(CREATE, &mut long), Err(Errno::EINVAL));
    }

    #[test]
    fn create_without_renderer_is_enodev() {
        let mut f = grouped();
        f.table.kgpu_parts().0.set_renderer_available(false);
        let mut arg = create_arg();
        assert_eq!(f.request(CREATE, &mut arg), Err(Errno::ENODEV));
        assert!(f.drain().is_empty());
    }

    #[test]
    fn ungrouped_caller_is_eopnotsupp() {
        let mut f = grouped();
        let loner = f.table.create_process().unwrap();
        for (op, mut arg) in [
            (CREATE, create_arg()),
            (DESTROY, destroy_arg(1)),
            (SUBMIT, submit_arg(1, 16, 0)),
            (WAIT, wait_arg(1, 1, 0)),
        ] {
            assert_eq!(
                f.table
                    .kgpu_request(&mut f.host, loner, loner, op, &mut arg),
                Err(Errno::EOPNOTSUPP)
            );
        }
    }

    #[test]
    fn submit_queues_record_with_extents_and_pins() {
        let mut f = grouped();
        let context = f.create();
        f.write_buffers(&[
            KgpuBuffer {
                addr: u64::from(DATA),
                len: PAGE,
                access: KGPU_ACCESS_WRITE,
            },
            KgpuBuffer {
                addr: u64::from(STREAM),
                len: 64,
                access: KGPU_ACCESS_READ,
            },
        ]);
        let (result, first) = f.submit(context, 2);
        assert_eq!(result, Ok(ParkOutcome::Done(0)));
        assert_eq!(first, 1);
        let (result, second) = f.submit(context, 0);
        assert_eq!(result, Ok(ParkOutcome::Done(0)));
        assert_eq!(second, 2);
        // The stream page, and the two pages the data buffer spans.
        assert_eq!(f.pinned(), 3);

        let bytes = f.drain();
        let create = decode_submission(&bytes).unwrap();
        assert_eq!(create.header.kind, SubmissionKind::ContextCreate);
        assert_eq!(create.header.context, context);
        let view = decode_submission(&bytes[create.encoded_len..]).unwrap();
        assert_eq!(
            view.header,
            SubmissionHeader {
                kind: SubmissionKind::Submit,
                context,
                seqno: 1
            }
        );
        let stream = f.extents(STREAM, 16);
        assert_eq!(view.stream_extent_count() as usize, stream.len());
        assert_eq!(view.stream_extent(0), Some(stream[0]));
        assert_eq!(view.buffer_count(), 2);
        let data = view.buffer(0).unwrap();
        assert_eq!(data.access, KGPU_ACCESS_WRITE);
        let expected = f.extents(DATA, PAGE);
        assert_eq!(data.extent_count() as usize, expected.len());
        for (i, extent) in expected.iter().enumerate() {
            assert_eq!(data.extent(i as u32), Some(*extent));
        }
        let read = view.buffer(1).unwrap();
        assert_eq!(read.access, KGPU_ACCESS_READ);
        assert_eq!(read.extent(0), Some(f.extents(STREAM, 64)[0]));
        let rest = &bytes[create.encoded_len + view.encoded_len..];
        assert_eq!(records(rest), vec![(SubmissionKind::Submit, context, 2)]);
        assert!(f.drain().is_empty(), "drained records are gone");
    }

    #[test]
    fn submit_bad_magic_is_einval() {
        let mut f = grouped();
        let context = f.create();
        f.drain();
        f.write_stream(stream::MAGIC ^ 1, stream::VERSION);
        assert_eq!(f.submit(context, 0).0, Err(Errno::EINVAL));
        f.write_stream(stream::MAGIC, stream::VERSION + 1);
        assert_eq!(f.submit(context, 0).0, Err(Errno::EINVAL));
        // A stream shorter than its header cannot carry one.
        let mut arg = submit_arg(context, 15, 0);
        assert_eq!(f.request(SUBMIT, &mut arg), Err(Errno::EINVAL));
        assert!(f.drain().is_empty());
        assert_eq!(f.pinned(), 0);
    }

    #[test]
    fn submit_unmapped_buffer_is_efault_and_nothing_queued() {
        let mut f = grouped();
        let context = f.create();
        f.drain();
        // Past the image's four initial pages.
        f.write_buffers(&[
            KgpuBuffer {
                addr: u64::from(DATA),
                len: 64,
                access: KGPU_ACCESS_READ,
            },
            KgpuBuffer {
                addr: u64::from(8 * PAGE),
                len: 64,
                access: KGPU_ACCESS_WRITE,
            },
        ]);
        assert_eq!(f.submit(context, 2).0, Err(Errno::EFAULT));
        assert!(f.drain().is_empty());
        assert_eq!(f.pinned(), 0);
        // The failed submission consumed no sequence number.
        assert_eq!(f.submit(context, 1), (Ok(ParkOutcome::Done(0)), 1));
    }

    #[test]
    fn wait_returns_after_retired_completion() {
        let mut f = grouped();
        let context = f.create();
        let (_, seqno) = f.submit(context, 0);
        f.drain();
        let generation = parked(f.request(WAIT, &mut wait_arg(context, seqno, -1)));
        assert!(decisions().is_empty());
        assert_eq!(f.pinned(), 1);
        f.complete(CompletionKind::Retired, context, seqno).unwrap();
        let done = decisions();
        assert_eq!(done.len(), 1);
        assert_eq!(
            (done[0].generation, done[0].pid, done[0].value),
            (generation, f.pid, 0)
        );
        assert_eq!(f.pinned(), 0, "retirement released the pins");
        // Already retired: answered at once.
        assert_eq!(
            f.request(WAIT, &mut wait_arg(context, seqno, -1)),
            Ok(ParkOutcome::Done(0))
        );
    }

    #[test]
    fn wait_zero_timeout_pending_is_etime() {
        let mut f = grouped();
        let context = f.create();
        let (_, seqno) = f.submit(context, 0);
        assert_eq!(
            f.request(WAIT, &mut wait_arg(context, seqno, 0)),
            Err(Errno::ETIME)
        );
        // A sequence number never submitted on this context can never retire.
        assert_eq!(
            f.request(WAIT, &mut wait_arg(context, seqno + 1, -1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn a_timed_wait_that_runs_out_is_etime() {
        let mut parks = crate::wait_park::Parks::new();
        let park = KgpuPark::Wait {
            device: DEVICE,
            context: 1,
            seqno: 1,
        };
        let generation = parks
            .park(
                1,
                1,
                WaitKind::Kgpu,
                vec![park.source()],
                Some(50),
                Resume::Kgpu(park),
            )
            .unwrap();
        parks.expire(50);
        let done = parks.take_completions();
        assert_eq!(
            (done[0].generation, done[0].value),
            (generation, -(Errno::ETIME as i32))
        );
    }

    #[test]
    fn wait_interrupted_by_signal_is_eintr() {
        let mut f = grouped();
        let context = f.create();
        let (_, seqno) = f.submit(context, 0);
        let generation = parked(f.request(WAIT, &mut wait_arg(context, seqno, -1)));
        f.table
            .get_mut(f.pid)
            .unwrap()
            .raise_signal(wasm_posix_shared::signal::SIGUSR1);
        crate::wait_park::with(|parks| {
            parks.note_signal_generated();
            parks.sweep_signals(&f.table);
        });
        let done = decisions();
        assert_eq!(done.len(), 1);
        assert_eq!(
            (done[0].generation, done[0].value),
            (generation, -(Errno::EINTR as i32))
        );
        assert_eq!(
            done[0].flags,
            wasm_posix_shared::wait_completion_wire::FLAG_SUPPRESS_RESTART
        );
    }

    #[test]
    fn context_lost_fails_waiters_and_submits_with_eio() {
        let mut f = grouped();
        let context = f.create();
        let (_, first) = f.submit(context, 0);
        f.drain();
        let (_, second) = f.submit(context, 0);
        let generation = parked(f.request(WAIT, &mut wait_arg(context, first, -1)));
        f.complete(CompletionKind::ContextLost, context, 0).unwrap();
        let done = decisions();
        assert_eq!(done.len(), 1);
        assert_eq!(
            (done[0].generation, done[0].value),
            (generation, -(Errno::EIO as i32))
        );
        assert_eq!(f.submit(context, 0).0, Err(Errno::EIO));
        assert_eq!(
            f.request(WAIT, &mut wait_arg(context, first, -1)),
            Err(Errno::EIO)
        );
        // The undrained submission never reaches the host, and its pin is
        // gone; the drained one stays pinned until the executor retires it.
        assert!(records(&f.drain()).iter().all(|r| r.2 != second));
        assert_eq!(f.pinned(), 1);
        f.complete(CompletionKind::Retired, context, first).unwrap();
        assert_eq!(f.pinned(), 0);
        // Work that retired before the loss still reports success.
        assert_eq!(
            f.request(WAIT, &mut wait_arg(context, first, -1)),
            Ok(ParkOutcome::Done(0))
        );
    }

    #[test]
    fn outbox_full_parks_submitter_until_drain() {
        let mut f = grouped();
        let context = f.create();
        // Large records fill the outbox in a few hundred submissions.
        let buffers = vec![
            KgpuBuffer {
                addr: u64::from(DATA),
                len: 64,
                access: KGPU_ACCESS_READ
            };
            abi::KGPU_MAX_BUFFERS as usize
        ];
        f.write_buffers(&buffers);
        let mut submitted = 0usize;
        let (generation, held) = loop {
            let (result, seqno) = f.submit(context, abi::KGPU_MAX_BUFFERS);
            submitted += 1;
            assert!(submitted < 1000, "the outbox never filled");
            match result {
                Ok(ParkOutcome::Done(0)) => continue,
                other => break (parked(other), seqno),
            }
        };
        assert_eq!(
            held, submitted as u64,
            "a held submission still has its seqno"
        );
        // A caught signal does not end a held submission.
        f.table
            .get_mut(f.pid)
            .unwrap()
            .raise_signal(wasm_posix_shared::signal::SIGUSR1);
        crate::wait_park::with(|parks| {
            parks.note_signal_generated();
            parks.sweep_signals(&f.table);
        });
        f.table.kgpu_settle();
        assert!(decisions().is_empty(), "still held");

        let first = f.drain();
        f.table.kgpu_settle();
        let done = decisions();
        assert_eq!(done.len(), 1);
        assert_eq!((done[0].generation, done[0].value), (generation, 0));
        assert!(records(&first).iter().all(|r| r.2 != held));
        assert_eq!(
            records(&f.drain()),
            vec![(SubmissionKind::Submit, context, held)]
        );
    }

    #[test]
    fn exit_with_inflight_keeps_pins_until_retired() {
        let mut f = grouped();
        let context = f.create();
        let (_, seqno) = f.submit(context, 0);
        f.drain();
        assert!(f.table.get_mut(f.pid).unwrap().record_normal_exit(0));
        f.table.kgpu_settle();
        assert_eq!(
            records(&f.drain()),
            vec![(SubmissionKind::ContextDestroy, context, 0)]
        );
        assert_eq!(f.pinned(), 1, "the executor may still be using the frames");
        f.complete(CompletionKind::Retired, context, seqno).unwrap();
        assert_eq!(f.pinned(), 0);
    }

    #[test]
    fn exec_destroys_the_old_images_contexts() {
        let mut f = grouped();
        let context = f.create();
        f.drain();
        // Exec keeps the pid; its parks and contexts belong to the old image.
        crate::wait_park::retire_process(f.pid);
        let mut arg = destroy_arg(context);
        assert_eq!(f.request(DESTROY, &mut arg), Err(Errno::ENOENT));
        assert_eq!(
            records(&f.drain()),
            vec![(SubmissionKind::ContextDestroy, context, 0)]
        );
        assert_ne!(f.create(), context, "context ids are never reused");
    }

    #[test]
    fn destroy_by_non_owner_is_eperm() {
        let mut f = grouped();
        let context = f.create();
        let other = f.table.create_process().unwrap();
        admit(&mut f.table, &mut f.host, f.group, other);
        let mut arg = destroy_arg(context);
        assert_eq!(
            f.table
                .kgpu_request(&mut f.host, other, other, DESTROY, &mut arg),
            Err(Errno::EPERM)
        );
        f.drain();
        assert_eq!(f.request(DESTROY, &mut arg), Ok(ParkOutcome::Done(0)));
        assert_eq!(
            records(&f.drain()),
            vec![(SubmissionKind::ContextDestroy, context, 0)]
        );
        assert_eq!(f.request(DESTROY, &mut arg), Err(Errno::ENOENT));
    }

    #[test]
    fn completion_records_are_validated_before_any_applies() {
        let mut f = grouped();
        let context = f.create();
        let (_, seqno) = f.submit(context, 0);
        // Not drained yet: the host cannot have retired it.
        assert_eq!(
            f.complete(CompletionKind::Retired, context, seqno),
            Err(Errno::EINVAL)
        );
        f.drain();
        assert_eq!(
            f.complete(CompletionKind::Retired, context, seqno + 1),
            Err(Errno::EINVAL)
        );
        assert_eq!(f.table.kgpu_complete(&[0u8; 23]), Err(Errno::EINVAL));
        // R4: a ContextReady is a no-op acknowledgement.
        f.complete(CompletionKind::ContextReady, context, 0)
            .unwrap();
        assert_eq!(f.pinned(), 1);
    }
}
