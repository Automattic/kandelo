extern crate alloc;

use alloc::collections::VecDeque;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

use wasm_posix_shared::Errno;
use wasm_posix_shared::flags::{O_ACCMODE, O_RDONLY};

use crate::lock::{FileId, OfdId};
use crate::ofd::FileType;

/// POSIX default pipe capacity.
pub const DEFAULT_PIPE_CAPACITY: usize = 65536;

/// POSIX atomicity guarantee threshold: writes of PIPE_BUF bytes or fewer
/// are guaranteed to be atomic.
pub const PIPE_BUF: usize = 4096;

/// An FD in transit via SCM_RIGHTS ancillary data.
///
/// Stores enough information to reconstruct the file descriptor
/// in the receiving process without needing access to the sender.
pub struct InFlightFd {
    pub ofd_id: OfdId,
    pub file_id: Option<FileId>,
    pub file_type: FileType,
    pub status_flags: u32,
    pub host_handle: i64,
    pub offset: i64,
    pub path: Vec<u8>,
    /// For socket FDs: serialized socket state.
    pub socket: Option<InFlightSocket>,
    /// True after this queued payload has acquired its one machine-wide
    /// backing and OfdId reference. Ownership transfers to the receiver or is
    /// released through the deferred queue on drop.
    owns_reference: bool,
}

impl InFlightFd {
    pub(crate) fn new(
        ofd_id: OfdId,
        file_id: Option<FileId>,
        file_type: FileType,
        status_flags: u32,
        host_handle: i64,
        offset: i64,
        path: Vec<u8>,
    ) -> Self {
        Self {
            ofd_id,
            file_id,
            file_type,
            status_flags,
            host_handle,
            offset,
            path,
            socket: None,
            owns_reference: false,
        }
    }

    fn release_metadata(&self) -> DeferredInFlightFdRelease {
        DeferredInFlightFdRelease {
            ofd_id: self.ofd_id,
            file_type: self.file_type,
            status_flags: self.status_flags,
            host_handle: self.host_handle,
            socket_send_idx: self.socket.as_ref().and_then(|socket| socket.send_buf_idx),
            socket_recv_idx: self.socket.as_ref().and_then(|socket| socket.recv_buf_idx),
            socket_global_pipes: self
                .socket
                .as_ref()
                .is_some_and(|socket| socket.global_pipes),
        }
    }

    /// Acquire the real resource and OfdId references represented by one
    /// queued SCM_RIGHTS entry.
    pub(crate) fn retain_reference(&mut self) -> Result<(), Errno> {
        if self.owns_reference {
            return Ok(());
        }
        reserve_deferred_in_flight_release()?;
        if let Err(err) = crate::ofd::retain_in_flight_ofd(self.ofd_id) {
            cancel_deferred_in_flight_release();
            return Err(err);
        }
        if let Err(err) = retain_in_flight_resource(self.release_metadata()) {
            crate::ofd::release_in_flight_ofd(self.ofd_id);
            cancel_deferred_in_flight_release();
            return Err(err);
        }
        self.owns_reference = true;
        Ok(())
    }

    /// Transfer the queued reference to a receiver-side OpenFileDesc without a
    /// decrement/re-increment window in the underlying resource ownership.
    pub(crate) fn transfer_reference(&mut self) {
        debug_assert!(self.owns_reference);
        if self.owns_reference {
            self.owns_reference = false;
            crate::ofd::release_in_flight_ofd(self.ofd_id);
            cancel_deferred_in_flight_release();
        }
    }

    #[cfg(test)]
    pub(crate) fn owns_reference(&self) -> bool {
        self.owns_reference
    }
}

impl Clone for InFlightFd {
    fn clone(&self) -> Self {
        let mut cloned = Self {
            ofd_id: self.ofd_id,
            file_id: self.file_id,
            file_type: self.file_type,
            status_flags: self.status_flags,
            host_handle: self.host_handle,
            offset: self.offset,
            path: self.path.clone(),
            socket: self.socket.clone(),
            owns_reference: false,
        };
        if self.owns_reference {
            cloned
                .retain_reference()
                .expect("failed to retain cloned in-flight OFD reference");
        }
        cloned
    }
}

impl Drop for InFlightFd {
    fn drop(&mut self) {
        if !self.owns_reference {
            return;
        }
        self.owns_reference = false;
        crate::ofd::release_in_flight_ofd(self.ofd_id);
        enqueue_deferred_in_flight_release(self.release_metadata());
    }
}

/// Serialized socket state for SCM_RIGHTS FD passing.
#[derive(Clone)]
pub struct InFlightSocket {
    pub domain: u8,    // 0=Unix, 1=Inet, 2=Inet6
    pub sock_type: u8, // 0=Stream, 1=Dgram
    pub protocol: u32,
    pub state: u8, // 0=Unbound, ..., 4=Closed
    pub send_buf_idx: Option<usize>,
    pub recv_buf_idx: Option<usize>,
    pub global_pipes: bool,
    pub shut_rd: bool,
    pub shut_wr: bool,
    pub bind_addr: [u8; 4],
    pub bind_port: u16,
    pub peer_addr: [u8; 4],
    pub peer_port: u16,
}

/// Fixed cleanup metadata queued by `InFlightFd::drop`. Drop never re-enters
/// the pipe, PTY, or descriptor-backing globals because it may itself be
/// running while one of those tables is mutably borrowed.
#[derive(Clone, Copy)]
pub(crate) struct DeferredInFlightFdRelease {
    pub ofd_id: OfdId,
    file_type: FileType,
    status_flags: u32,
    host_handle: i64,
    socket_send_idx: Option<usize>,
    socket_recv_idx: Option<usize>,
    socket_global_pipes: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ReleasedInFlightFd {
    pub ofd_id: OfdId,
    pub final_ofd_reference: bool,
    pub host_close: Option<i64>,
}

struct DeferredInFlightReleaseQueue {
    records: Vec<DeferredInFlightFdRelease>,
    /// Capacity promised to live `InFlightFd` values whose destructor may
    /// enqueue one record. Reserving before ownership is acquired keeps Drop
    /// allocation-free even with the kernel's non-reclaiming allocator.
    reserved: usize,
}

struct DeferredInFlightReleases(UnsafeCell<Option<DeferredInFlightReleaseQueue>>);
unsafe impl Sync for DeferredInFlightReleases {}

static DEFERRED_IN_FLIGHT_RELEASES: DeferredInFlightReleases =
    DeferredInFlightReleases(UnsafeCell::new(None));

fn deferred_in_flight_releases() -> &'static mut DeferredInFlightReleaseQueue {
    let slot = unsafe { &mut *DEFERRED_IN_FLIGHT_RELEASES.0.get() };
    slot.get_or_insert_with(|| DeferredInFlightReleaseQueue {
        records: Vec::new(),
        reserved: 0,
    })
}

fn reserve_deferred_in_flight_release() -> Result<(), Errno> {
    let queue = deferred_in_flight_releases();
    if queue.records.capacity() - queue.records.len() <= queue.reserved {
        queue
            .records
            .try_reserve(queue.reserved.checked_add(1).ok_or(Errno::EOVERFLOW)?)
            .map_err(|_| Errno::ENOMEM)?;
    }
    queue.reserved += 1;
    Ok(())
}

fn cancel_deferred_in_flight_release() {
    let queue = deferred_in_flight_releases();
    debug_assert!(queue.reserved > 0);
    queue.reserved = queue.reserved.saturating_sub(1);
}

fn enqueue_deferred_in_flight_release(release: DeferredInFlightFdRelease) {
    let queue = deferred_in_flight_releases();
    debug_assert!(queue.reserved > 0);
    debug_assert!(queue.records.len() < queue.records.capacity());
    queue.reserved = queue.reserved.saturating_sub(1);
    queue.records.push(release);
}

pub(crate) fn pop_deferred_in_flight_release() -> Option<DeferredInFlightFdRelease> {
    deferred_in_flight_releases().records.pop()
}

#[cfg(test)]
pub(crate) fn deferred_in_flight_release_state() -> (usize, usize, usize) {
    let queue = deferred_in_flight_releases();
    (queue.records.len(), queue.reserved, queue.records.capacity())
}

fn retain_in_flight_resource(release: DeferredInFlightFdRelease) -> Result<(), Errno> {
    if crate::descriptor_backing::add_ref_for_ofd(release.file_type, release.host_handle)? {
        return Ok(());
    }

    match release.file_type {
        FileType::Regular | FileType::Directory | FileType::CharDevice
            if release.host_handle >= 0 =>
        {
            crate::ofd::host_handle_fork_ref(release.host_handle);
        }
        FileType::Pipe if release.host_handle >= 0 => {
            crate::ofd::host_handle_fork_ref(release.host_handle);
        }
        FileType::Pipe => {
            let pipe_idx = (-(release.host_handle + 1)) as usize;
            let pipe = unsafe { global_pipe_table() }
                .get_mut(pipe_idx)
                .ok_or(Errno::EBADF)?;
            if release.status_flags & O_ACCMODE == O_RDONLY {
                pipe.add_reader();
            } else {
                pipe.add_writer();
            }
        }
        FileType::Socket if release.socket_global_pipes => {
            let pipes = unsafe { global_pipe_table() };
            if release
                .socket_send_idx
                .is_some_and(|idx| pipes.get(idx).is_none())
                || release
                    .socket_recv_idx
                    .is_some_and(|idx| pipes.get(idx).is_none())
            {
                return Err(Errno::EBADF);
            }
            if let Some(idx) = release.socket_send_idx {
                pipes.get_mut(idx).unwrap().add_writer();
            }
            if let Some(idx) = release.socket_recv_idx {
                pipes.get_mut(idx).unwrap().add_reader();
            }
        }
        FileType::PtyMaster | FileType::PtySlave => {
            let pty = crate::pty::get_pty(release.host_handle as usize).ok_or(Errno::EBADF)?;
            if release.file_type == FileType::PtyMaster {
                pty.master_refs = pty.master_refs.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            } else {
                pty.slave_refs = pty.slave_refs.checked_add(1).ok_or(Errno::EOVERFLOW)?;
            }
        }
        FileType::Epoll => return Err(Errno::EINVAL),
        _ => {}
    }
    Ok(())
}

/// Release one deferred queued reference after the table borrow that dropped
/// it has ended. Any nested ancillary payload discarded by closing a pipe is
/// queued for a later iteration by the caller.
pub(crate) fn release_deferred_in_flight_resource(
    release: DeferredInFlightFdRelease,
) -> ReleasedInFlightFd {
    let mut final_ofd_reference = false;
    let mut host_close = None;

    if crate::descriptor_backing::manages_ofd(release.file_type, release.host_handle) {
        final_ofd_reference =
            crate::descriptor_backing::release_for_ofd(release.file_type, release.host_handle);
    } else {
        match release.file_type {
            FileType::Regular | FileType::Directory | FileType::CharDevice
                if release.host_handle >= 0 =>
            {
                if crate::ofd::host_handle_close_ref(release.host_handle) {
                    final_ofd_reference = true;
                    host_close = Some(release.host_handle);
                }
            }
            FileType::Pipe if release.host_handle >= 0 => {
                if crate::ofd::host_handle_close_ref(release.host_handle) {
                    host_close = Some(release.host_handle);
                }
            }
            FileType::Pipe => {
                let pipe_idx = (-(release.host_handle + 1)) as usize;
                let pipes = unsafe { global_pipe_table() };
                if let Some(pipe) = pipes.get_mut(pipe_idx) {
                    if release.status_flags & O_ACCMODE == O_RDONLY {
                        pipe.close_read_end();
                    } else {
                        pipe.close_write_end();
                    }
                }
                pipes.free_if_closed(pipe_idx);
            }
            FileType::Socket if release.socket_global_pipes => {
                let pipes = unsafe { global_pipe_table() };
                if let Some(idx) = release.socket_send_idx {
                    if let Some(pipe) = pipes.get_mut(idx) {
                        pipe.close_write_end();
                    }
                    pipes.free_if_closed(idx);
                }
                if let Some(idx) = release.socket_recv_idx {
                    if let Some(pipe) = pipes.get_mut(idx) {
                        pipe.close_read_end();
                    }
                    pipes.free_if_closed(idx);
                }
            }
            FileType::PtyMaster | FileType::PtySlave => {
                let pty_idx = release.host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    if release.file_type == FileType::PtyMaster {
                        pty.master_refs = pty.master_refs.saturating_sub(1);
                    } else {
                        pty.slave_refs = pty.slave_refs.saturating_sub(1);
                    }
                    if !pty.is_alive() {
                        crate::pty::free_pty(pty_idx);
                    }
                }
            }
            _ => {}
        }
    }

    ReleasedInFlightFd {
        ofd_id: release.ofd_id,
        final_ofd_reference,
        host_close,
    }
}

/// A ring buffer backing a pipe.
///
/// Uses a fixed-capacity `Vec<u8>` with head/tail pointers and a length
/// counter for O(1) read and write operations.
///
/// Endpoints are reference-counted: `read_count` and `write_count` track
/// how many open file descriptions reference each end. This supports
/// cross-process pipe sharing (e.g., after fork).
pub struct PipeBuffer {
    buf: Vec<u8>,
    head: usize,
    tail: usize,
    len: usize,
    read_count: u32,
    write_count: u32,
    /// The receive half of a normally closed TCP endpoint remains as an
    /// orphaned discard sink until the peer closes its write half. This models
    /// TCP's simplex FIN without inventing a fixed number of successful writes
    /// after EOF.
    orphaned_read: bool,
    /// Index of this pipe in the PipeTable (for wakeup events).
    pipe_idx: u32,
    /// Ancillary data queue for SCM_RIGHTS FD passing.
    /// Each entry is a batch of FDs sent with one sendmsg call.
    ancillary_fds: VecDeque<Vec<InFlightFd>>,
}

impl PipeBuffer {
    /// Create a new pipe buffer with the given capacity.
    pub fn new(capacity: usize) -> Self {
        let mut buf = Vec::new();
        buf.resize(capacity, 0u8);
        PipeBuffer {
            buf,
            head: 0,
            tail: 0,
            len: 0,
            read_count: 1,
            write_count: 1,
            orphaned_read: false,
            pipe_idx: 0,
            ancillary_fds: VecDeque::new(),
        }
    }

    /// Total capacity of the buffer.
    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    /// Number of bytes available for reading.
    pub fn available(&self) -> usize {
        self.len
    }

    /// Number of bytes of free space available for writing.
    pub fn free_space(&self) -> usize {
        self.capacity() - self.len
    }

    /// Returns true if the buffer contains no data.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Write data into the ring buffer, returning the number of bytes written.
    ///
    /// Performs a partial write if the buffer does not have enough free space
    /// for all of `data`. Returns 0 if the buffer is full.
    pub fn write(&mut self, data: &[u8]) -> usize {
        if self.read_count == 0 {
            return if self.orphaned_read { data.len() } else { 0 };
        }
        let cap = self.capacity();
        let n = data.len().min(self.free_space());
        if n == 0 {
            return 0;
        }
        let first = cap - self.tail;
        if n <= first {
            self.buf[self.tail..self.tail + n].copy_from_slice(&data[..n]);
        } else {
            self.buf[self.tail..self.tail + first].copy_from_slice(&data[..first]);
            self.buf[0..n - first].copy_from_slice(&data[first..n]);
        }
        self.tail = (self.tail + n) % cap;
        self.len += n;
        // Data written → pipe became readable
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
        n
    }

    /// Read data from the ring buffer without consuming it, returning the
    /// number of bytes read.
    ///
    /// This is equivalent to `read()` but the head pointer and length are
    /// not modified, so the same data can be read again.
    ///
    /// Returns 0 if the buffer is empty.
    pub fn peek(&self, buf: &mut [u8]) -> usize {
        let cap = self.capacity();
        let n = buf.len().min(self.len);
        if n == 0 {
            return 0;
        }
        let first = cap - self.head;
        if n <= first {
            buf[..n].copy_from_slice(&self.buf[self.head..self.head + n]);
        } else {
            buf[..first].copy_from_slice(&self.buf[self.head..self.head + first]);
            buf[first..n].copy_from_slice(&self.buf[0..n - first]);
        }
        n
    }

    /// Read data from the ring buffer into `buf`, returning the number of
    /// bytes read.
    ///
    /// Returns 0 if the buffer is empty.
    pub fn read(&mut self, buf: &mut [u8]) -> usize {
        let cap = self.capacity();
        let n = buf.len().min(self.len);
        if n == 0 {
            return 0;
        }
        let first = cap - self.head;
        if n <= first {
            buf[..n].copy_from_slice(&self.buf[self.head..self.head + n]);
        } else {
            buf[..first].copy_from_slice(&self.buf[self.head..self.head + first]);
            buf[first..n].copy_from_slice(&self.buf[0..n - first]);
        }
        self.head = (self.head + n) % cap;
        self.len -= n;
        // Data consumed → pipe became writable
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
        n
    }

    /// Close one read end of the pipe. Decrements the read reference count.
    pub fn close_read_end(&mut self) {
        self.read_count = self.read_count.saturating_sub(1);
        if self.read_count == 0 {
            self.orphaned_read = false;
            self.head = 0;
            self.tail = 0;
            self.len = 0;
            // No process can receive these queued descriptors now. Dropping
            // them only enqueues fixed cleanup metadata; resource tables are
            // drained after this PipeBuffer borrow ends.
            self.ancillary_fds.clear();
        }
        // Read end closed → pipe became writable (writers get EPIPE/SIGPIPE)
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }

    /// Close one TCP read end with orderly-close semantics.
    ///
    /// The last real reader becomes an orphaned discard sink while a writer is
    /// still open. This is the pipe-backed equivalent of an operating system
    /// retaining a TCP control block after the application closes its socket.
    /// Explicit read shutdown uses `close_read_end` instead.
    pub fn close_read_end_orderly(&mut self) {
        self.read_count = self.read_count.saturating_sub(1);
        if self.read_count == 0 {
            self.head = 0;
            self.tail = 0;
            self.len = 0;
            self.orphaned_read = self.write_count > 0;
            self.ancillary_fds.clear();
        }
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }

    /// Close one write end of the pipe. Decrements the write reference count.
    pub fn close_write_end(&mut self) {
        self.write_count = self.write_count.saturating_sub(1);
        if self.write_count == 0 {
            self.orphaned_read = false;
        }
        // Write end closed → pipe became readable (readers get EOF)
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
    }

    /// Add a reader reference (e.g., after fork or dup).
    pub fn add_reader(&mut self) {
        self.orphaned_read = false;
        self.read_count += 1;
    }

    /// Add a writer reference (e.g., after fork or dup).
    pub fn add_writer(&mut self) {
        self.write_count += 1;
    }

    /// Returns true if the read end is still open (any readers remain).
    pub fn is_read_end_open(&self) -> bool {
        self.read_count > 0 || self.orphaned_read
    }

    /// Returns true if an application-owned reader remains.
    ///
    /// Unlike `is_read_end_open`, this excludes TCP's orphaned discard sink so
    /// host bridges can distinguish SHUT_WR from a final close.
    pub fn has_readers(&self) -> bool {
        self.read_count > 0
    }

    /// Returns true if the write end is still open (any writers remain).
    pub fn is_write_end_open(&self) -> bool {
        self.write_count > 0
    }

    /// Returns true if both endpoints are closed and the pipe can be freed.
    pub fn is_fully_closed(&self) -> bool {
        self.read_count == 0 && self.write_count == 0 && !self.orphaned_read
    }

    /// Push ancillary FDs (SCM_RIGHTS) to be delivered with the next recvmsg.
    pub fn push_ancillary(&mut self, fds: Vec<InFlightFd>) {
        if !fds.is_empty() {
            self.ancillary_fds.push_back(fds);
        }
    }

    /// Pop ancillary FDs (SCM_RIGHTS) for the next recvmsg call.
    pub fn pop_ancillary(&mut self) -> Option<Vec<InFlightFd>> {
        self.ancillary_fds.pop_front()
    }

    /// Returns true if there are ancillary FDs pending delivery.
    pub fn has_ancillary(&self) -> bool {
        !self.ancillary_fds.is_empty()
    }
}

/// Table of pipe buffers shared across all processes.
pub struct PipeTable {
    pipes: Vec<Option<PipeBuffer>>,
    free_list: Vec<usize>,
}

impl PipeTable {
    pub const fn new() -> Self {
        PipeTable {
            pipes: Vec::new(),
            free_list: Vec::new(),
        }
    }

    /// Allocate a pipe buffer in the table. Returns the index.
    pub fn alloc(&mut self, mut pipe: PipeBuffer) -> usize {
        if let Some(i) = self.free_list.pop() {
            pipe.pipe_idx = i as u32;
            self.pipes[i] = Some(pipe);
            return i;
        }
        let i = self.pipes.len();
        pipe.pipe_idx = i as u32;
        self.pipes.push(Some(pipe));
        i
    }

    /// Allocate two pipe buffers with adjacent indices (`second_idx == first_idx + 1`).
    /// The host TCP-bridge code assumes the recv and send pipes for an injected
    /// connection are consecutive (`sendPipeIdx = recvPipeIdx + 1`); this helper
    /// preserves that invariant in the global table by skipping the free list
    /// when it can't supply two consecutive slots.
    pub fn alloc_pair(&mut self, first: PipeBuffer, second: PipeBuffer) -> (usize, usize) {
        // Try to find two consecutive freed slots in the free_list. The free
        // list is a Vec of indices; sort a copy and scan for adjacent pairs.
        if self.free_list.len() >= 2 {
            let mut sorted = self.free_list.clone();
            sorted.sort_unstable();
            for w in sorted.windows(2) {
                if w[1] == w[0] + 1 {
                    let a = w[0];
                    let b = w[1];
                    self.free_list.retain(|&x| x != a && x != b);
                    let mut p1 = first;
                    p1.pipe_idx = a as u32;
                    self.pipes[a] = Some(p1);
                    let mut p2 = second;
                    p2.pipe_idx = b as u32;
                    self.pipes[b] = Some(p2);
                    return (a, b);
                }
            }
        }
        // No consecutive freed pair — append both to the tail.
        let a = self.pipes.len();
        let b = a + 1;
        let mut p1 = first;
        p1.pipe_idx = a as u32;
        self.pipes.push(Some(p1));
        let mut p2 = second;
        p2.pipe_idx = b as u32;
        self.pipes.push(Some(p2));
        (a, b)
    }

    /// Get a reference to a pipe buffer by index.
    pub fn get(&self, idx: usize) -> Option<&PipeBuffer> {
        self.pipes.get(idx).and_then(|p| p.as_ref())
    }

    /// Get a mutable reference to a pipe buffer by index.
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut PipeBuffer> {
        self.pipes.get_mut(idx).and_then(|p| p.as_mut())
    }

    /// Free a pipe buffer slot if both endpoints are closed.
    pub fn free_if_closed(&mut self, idx: usize) {
        if let Some(Some(pipe)) = self.pipes.get(idx) {
            if pipe.is_fully_closed() {
                self.pipes[idx] = None;
                self.free_list.push(idx);
            }
        }
    }

    /// Release both endpoints of a newly allocated buffer that was never
    /// published to a socket or host bridge, then make its slot reusable.
    pub fn discard_unclaimed(&mut self, idx: usize) {
        if let Some(pipe) = self.get_mut(idx) {
            pipe.close_read_end();
            pipe.close_write_end();
        }
        self.free_if_closed(idx);
    }

    /// Total number of slots (including freed).
    pub fn len(&self) -> usize {
        self.pipes.len()
    }

    /// Number of active (non-None) pipe buffers.
    #[cfg(test)]
    pub fn count_active(&self) -> usize {
        self.pipes.iter().filter(|p| p.is_some()).count()
    }
}

/// Global pipe table wrapper for static storage.
pub struct GlobalPipeTable(pub UnsafeCell<PipeTable>);

/// SAFETY: Access is serialized — the kernel services one syscall at a time
/// from the JS event loop (no concurrent Wasm execution).
unsafe impl Sync for GlobalPipeTable {}

/// Global pipe table shared across all processes.
pub static PIPE_TABLE: GlobalPipeTable = GlobalPipeTable(UnsafeCell::new(PipeTable::new()));

/// Get a mutable reference to the global pipe table.
///
/// # Safety
/// Only safe when access is serialized (single-threaded kernel).
pub unsafe fn global_pipe_table() -> &'static mut PipeTable {
    unsafe { &mut *PIPE_TABLE.0.get() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_write_and_read() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        let written = pipe.write(b"hello");
        assert_eq!(written, 5);

        let mut buf = [0u8; 5];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 5);
        assert_eq!(&buf, b"hello");
    }

    #[test]
    fn test_fifo_ordering() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        pipe.write(b"first");
        pipe.write(b"second");

        let mut buf = [0u8; 11];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 11);
        assert_eq!(&buf[..11], b"firstsecond");
    }

    #[test]
    fn test_full_buffer() {
        let mut pipe = PipeBuffer::new(8);
        let written = pipe.write(b"12345678");
        assert_eq!(written, 8);

        // Buffer is full, additional write should return 0
        let written = pipe.write(b"abcd");
        assert_eq!(written, 0);
    }

    #[test]
    fn test_wraparound() {
        let mut pipe = PipeBuffer::new(8);

        // Fill the buffer
        let written = pipe.write(b"12345678");
        assert_eq!(written, 8);

        // Read 4 bytes, freeing space at the beginning
        let mut buf = [0u8; 4];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 4);
        assert_eq!(&buf, b"1234");

        // Write 4 more bytes -- these wrap around to the beginning
        let written = pipe.write(b"abcd");
        assert_eq!(written, 4);

        // Read all 8 bytes: the remaining "5678" plus the wrapped "abcd"
        let mut buf = [0u8; 8];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 8);
        assert_eq!(&buf, b"5678abcd");
    }

    #[test]
    fn test_empty_read() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        let mut buf = [0u8; 10];
        let read = pipe.read(&mut buf);
        assert_eq!(read, 0);
    }

    #[test]
    fn test_partial_write() {
        let mut pipe = PipeBuffer::new(8);
        let written = pipe.write(b"12345");
        assert_eq!(written, 5);

        // Only 3 bytes of free space remain, so only 3 of the 5 bytes
        // should be written.
        let written = pipe.write(b"abcde");
        assert_eq!(written, 3);
    }

    #[test]
    fn test_close_endpoints() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        assert!(pipe.is_read_end_open());
        assert!(pipe.is_write_end_open());

        pipe.close_write_end();
        assert!(!pipe.is_write_end_open());
        assert!(pipe.is_read_end_open());

        pipe.close_read_end();
        assert!(!pipe.is_read_end_open());
    }

    #[test]
    fn test_pipe_peek() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        pipe.write(b"hello");
        let mut buf = [0u8; 5];
        // Peek should read without consuming
        let n = pipe.peek(&mut buf);
        assert_eq!(n, 5);
        assert_eq!(&buf[..5], b"hello");
        // Data should still be available for regular read
        let n2 = pipe.read(&mut buf);
        assert_eq!(n2, 5);
        assert_eq!(&buf[..5], b"hello");
    }

    #[test]
    fn test_capacity_and_counts() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        assert_eq!(pipe.capacity(), DEFAULT_PIPE_CAPACITY);
        assert_eq!(pipe.available(), 0);
        assert_eq!(pipe.free_space(), DEFAULT_PIPE_CAPACITY);

        pipe.write(b"hello");
        assert_eq!(pipe.available(), 5);
        assert_eq!(pipe.free_space(), DEFAULT_PIPE_CAPACITY - 5);
    }

    #[test]
    fn test_ref_counting() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        assert!(pipe.is_read_end_open());
        assert!(pipe.is_write_end_open());

        // Add extra reader and writer (simulating fork)
        pipe.add_reader();
        pipe.add_writer();

        // Close one reader — still open
        pipe.close_read_end();
        assert!(pipe.is_read_end_open());
        assert!(!pipe.is_fully_closed());

        // Close second reader — now closed
        pipe.close_read_end();
        assert!(!pipe.is_read_end_open());
        assert!(!pipe.is_fully_closed()); // writer still open

        // Close both writers
        pipe.close_write_end();
        assert!(!pipe.is_fully_closed());
        pipe.close_write_end();
        assert!(pipe.is_fully_closed());
    }

    #[test]
    fn test_orderly_read_close_discards_until_last_writer_closes() {
        let mut pipe = PipeBuffer::new(8);

        pipe.close_read_end_orderly();
        assert!(pipe.is_read_end_open());
        assert!(!pipe.has_readers());
        assert_eq!(pipe.write(b"first"), 5);
        assert_eq!(pipe.write(b"larger than capacity"), 20);
        assert_eq!(pipe.available(), 0);
        assert!(!pipe.is_fully_closed());

        pipe.close_write_end();
        assert!(!pipe.is_read_end_open());
        assert!(pipe.is_fully_closed());
    }

    #[test]
    fn test_orderly_read_close_preserves_other_real_readers() {
        let mut pipe = PipeBuffer::new(8);
        pipe.add_reader();

        pipe.close_read_end_orderly();
        assert!(pipe.has_readers());
        assert_eq!(pipe.write(b"live"), 4);
        let mut buf = [0u8; 4];
        assert_eq!(pipe.read(&mut buf), 4);
        assert_eq!(&buf, b"live");

        pipe.close_read_end_orderly();
        assert!(!pipe.has_readers());
        assert_eq!(pipe.write(b"discarded"), 9);
        assert_eq!(pipe.available(), 0);
        pipe.close_write_end();
        assert!(pipe.is_fully_closed());
    }

    #[test]
    fn test_pipe_table_alloc_and_free() {
        let mut table = PipeTable::new();
        let idx = table.alloc(PipeBuffer::new(64));
        assert_eq!(idx, 0);

        let idx2 = table.alloc(PipeBuffer::new(64));
        assert_eq!(idx2, 1);

        // Close both endpoints of first pipe
        table.get_mut(idx).unwrap().close_read_end();
        table.get_mut(idx).unwrap().close_write_end();
        table.free_if_closed(idx);

        // Slot 0 should be reusable
        let idx3 = table.alloc(PipeBuffer::new(64));
        assert_eq!(idx3, 0);
    }

    #[test]
    fn test_pipe_table_discards_unclaimed_slot() {
        let mut table = PipeTable::new();
        let idx = table.alloc(PipeBuffer::new(64));

        table.discard_unclaimed(idx);

        assert_eq!(table.count_active(), 0);
        assert_eq!(table.alloc(PipeBuffer::new(64)), idx);
    }
}
