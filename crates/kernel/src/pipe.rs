extern crate alloc;

use alloc::collections::VecDeque;
use alloc::vec::Vec;
use core::cell::UnsafeCell;

/// POSIX default pipe capacity.
pub const DEFAULT_PIPE_CAPACITY: usize = 65536;

/// POSIX atomicity guarantee threshold: writes of PIPE_BUF bytes or fewer
/// are guaranteed to be atomic.
pub const PIPE_BUF: usize = 4096;

/// An FD in transit via SCM_RIGHTS ancillary data.
///
/// Stores enough information to reconstruct the file descriptor
/// in the receiving process without needing access to the sender.
#[derive(Clone)]
pub struct InFlightFd {
    /// FileType discriminant (Pipe=0, Socket=1, Regular=2, etc.)
    pub file_type: u8,
    pub status_flags: u32,
    pub host_handle: i64,
    pub offset: i64,
    pub path: Vec<u8>,
    /// For socket FDs: serialized socket state.
    pub socket: Option<InFlightSocket>,
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
    /// Endpoint references owned by descriptors queued in SCM_RIGHTS messages.
    /// These are included in read_count/write_count, but tracked separately so
    /// unreachable cycles of queued socket descriptors can be collected.
    in_flight_read_count: u32,
    in_flight_write_count: u32,
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
            in_flight_read_count: 0,
            in_flight_write_count: 0,
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

    fn retain_in_flight_reader(&mut self) {
        self.add_reader();
        self.in_flight_read_count += 1;
    }

    fn retain_in_flight_writer(&mut self) {
        self.add_writer();
        self.in_flight_write_count += 1;
    }

    fn adopt_in_flight_reader(&mut self) {
        debug_assert!(self.in_flight_read_count > 0);
        self.in_flight_read_count = self.in_flight_read_count.saturating_sub(1);
    }

    fn adopt_in_flight_writer(&mut self) {
        debug_assert!(self.in_flight_write_count > 0);
        self.in_flight_write_count = self.in_flight_write_count.saturating_sub(1);
    }

    fn release_in_flight_reader(&mut self) {
        debug_assert!(self.in_flight_read_count > 0);
        self.in_flight_read_count = self.in_flight_read_count.saturating_sub(1);
        self.close_read_end();
    }

    fn release_in_flight_reader_orderly(&mut self) {
        debug_assert!(self.in_flight_read_count > 0);
        self.in_flight_read_count = self.in_flight_read_count.saturating_sub(1);
        self.close_read_end_orderly();
    }

    fn release_in_flight_writer(&mut self) {
        debug_assert!(self.in_flight_write_count > 0);
        self.in_flight_write_count = self.in_flight_write_count.saturating_sub(1);
        self.close_write_end();
    }

    fn has_external_reader(&self) -> bool {
        self.read_count > self.in_flight_read_count
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
    fn push_ancillary(&mut self, fds: Vec<InFlightFd>) {
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

    /// Queue one SCM_RIGHTS message and retain every pipe-backed resource it
    /// carries. The message is collected immediately if no live or reachable
    /// socket endpoint can ever receive it.
    pub fn queue_ancillary(&mut self, carrier_idx: usize, fds: Vec<InFlightFd>) -> bool {
        if self.get(carrier_idx).is_none() || !self.retain_ancillary_resources(&fds) {
            return false;
        }
        self.get_mut(carrier_idx).unwrap().push_ancillary(fds);
        self.collect_unreachable_ancillary();
        true
    }

    /// Retain every pipe-backed resource carried by one SCM_RIGHTS message.
    ///
    /// A successful send owns these references while the descriptors are in
    /// transit. Receiving a descriptor transfers the matching reference to
    /// the new OFD; discarding the message releases it instead.
    pub fn retain_ancillary_resources(&mut self, fds: &[InFlightFd]) -> bool {
        for (retained, fd) in fds.iter().enumerate() {
            if !self.retain_ancillary_resource(fd) {
                for retained_fd in &fds[..retained] {
                    self.release_ancillary_resource_inner(retained_fd);
                }
                self.collect_unreachable_ancillary();
                return false;
            }
        }
        true
    }

    /// Release pipe-backed resources for SCM_RIGHTS descriptors that were not
    /// installed in a receiving process.
    pub fn release_ancillary_resources(&mut self, fds: &[InFlightFd]) {
        for fd in fds {
            self.release_ancillary_resource_inner(fd);
        }
        self.collect_unreachable_ancillary();
    }

    /// Transfer one retained SCM_RIGHTS reference into a newly installed OFD.
    /// Call finish_ancillary_transition after every entry in the popped batch
    /// has either been adopted or released.
    pub fn adopt_ancillary_resource(&mut self, fd: &InFlightFd) {
        self.adopt_ancillary_resource_inner(fd);
    }

    /// Release one entry from a popped SCM_RIGHTS batch that could not be
    /// installed. Collection is deferred until the entire batch is resolved.
    pub fn release_ancillary_resource(&mut self, fd: &InFlightFd) {
        self.release_ancillary_resource_inner(fd);
    }

    /// Complete a popped SCM_RIGHTS batch after every reference was adopted or
    /// released, then collect cycles made unreachable by removing that queue.
    pub fn finish_ancillary_transition(&mut self) {
        self.collect_unreachable_ancillary();
    }

    fn retain_ancillary_resource(&mut self, fd: &InFlightFd) -> bool {
        if fd.file_type == 0 && fd.host_handle < 0 {
            let pipe_idx = (-(fd.host_handle + 1)) as usize;
            let Some(pipe) = self.get_mut(pipe_idx) else {
                return false;
            };
            match fd.status_flags & wasm_posix_shared::flags::O_ACCMODE {
                wasm_posix_shared::flags::O_RDONLY => pipe.retain_in_flight_reader(),
                wasm_posix_shared::flags::O_WRONLY => pipe.retain_in_flight_writer(),
                wasm_posix_shared::flags::O_RDWR => {
                    pipe.retain_in_flight_reader();
                    pipe.retain_in_flight_writer();
                }
                _ => return false,
            }
        } else if fd.file_type == 1 {
            let Some(socket) = fd.socket.as_ref() else {
                return true;
            };
            if !socket.global_pipes {
                return true;
            }

            if let Some(send_idx) = socket.send_buf_idx {
                let Some(pipe) = self.get_mut(send_idx) else {
                    return false;
                };
                pipe.retain_in_flight_writer();
            }
            if let Some(recv_idx) = socket.recv_buf_idx {
                let Some(pipe) = self.get_mut(recv_idx) else {
                    if let Some(send_idx) = socket.send_buf_idx {
                        if let Some(pipe) = self.get_mut(send_idx) {
                            pipe.release_in_flight_writer();
                        }
                        self.free_fully_closed_inner(send_idx);
                    }
                    return false;
                };
                pipe.retain_in_flight_reader();
            }
        }
        true
    }

    fn adopt_ancillary_resource_inner(&mut self, fd: &InFlightFd) {
        if fd.file_type == 0 && fd.host_handle < 0 {
            let pipe_idx = (-(fd.host_handle + 1)) as usize;
            if let Some(pipe) = self.get_mut(pipe_idx) {
                match fd.status_flags & wasm_posix_shared::flags::O_ACCMODE {
                    wasm_posix_shared::flags::O_RDONLY => pipe.adopt_in_flight_reader(),
                    wasm_posix_shared::flags::O_WRONLY => pipe.adopt_in_flight_writer(),
                    wasm_posix_shared::flags::O_RDWR => {
                        pipe.adopt_in_flight_reader();
                        pipe.adopt_in_flight_writer();
                    }
                    _ => {}
                }
            }
        } else if fd.file_type == 1 {
            let Some(socket) = fd.socket.as_ref() else {
                return;
            };
            if !socket.global_pipes {
                return;
            }
            if let Some(send_idx) = socket.send_buf_idx {
                if let Some(pipe) = self.get_mut(send_idx) {
                    pipe.adopt_in_flight_writer();
                }
            }
            if let Some(recv_idx) = socket.recv_buf_idx {
                if let Some(pipe) = self.get_mut(recv_idx) {
                    pipe.adopt_in_flight_reader();
                }
            }
        }
    }

    fn release_ancillary_resource_inner(&mut self, fd: &InFlightFd) {
        if fd.file_type == 0 && fd.host_handle < 0 {
            let pipe_idx = (-(fd.host_handle + 1)) as usize;
            if let Some(pipe) = self.get_mut(pipe_idx) {
                match fd.status_flags & wasm_posix_shared::flags::O_ACCMODE {
                    wasm_posix_shared::flags::O_RDONLY => pipe.release_in_flight_reader(),
                    wasm_posix_shared::flags::O_WRONLY => pipe.release_in_flight_writer(),
                    wasm_posix_shared::flags::O_RDWR => {
                        pipe.release_in_flight_reader();
                        pipe.release_in_flight_writer();
                    }
                    _ => {}
                }
            }
            self.free_fully_closed_inner(pipe_idx);
        } else if fd.file_type == 1 {
            let Some(socket) = fd.socket.as_ref() else {
                return;
            };
            if !socket.global_pipes {
                return;
            }

            if let Some(send_idx) = socket.send_buf_idx {
                if let Some(pipe) = self.get_mut(send_idx) {
                    pipe.release_in_flight_writer();
                }
                self.free_fully_closed_inner(send_idx);
            }
            if let Some(recv_idx) = socket.recv_buf_idx {
                if let Some(pipe) = self.get_mut(recv_idx) {
                    let orderly_tcp_close = socket.sock_type == 0
                        && matches!(socket.domain, 1 | 2);
                    if orderly_tcp_close {
                        pipe.release_in_flight_reader_orderly();
                    } else {
                        pipe.release_in_flight_reader();
                    }
                }
                self.free_fully_closed_inner(recv_idx);
            }
        }
    }

    /// Free a pipe buffer slot if both endpoints are closed.
    pub fn free_if_closed(&mut self, idx: usize) {
        self.free_fully_closed_inner(idx);
        self.collect_unreachable_ancillary();
    }

    fn free_fully_closed_inner(&mut self, idx: usize) {
        let should_free = self
            .pipes
            .get(idx)
            .and_then(Option::as_ref)
            .is_some_and(PipeBuffer::is_fully_closed);
        if !should_free {
            return;
        }

        let pipe = self.pipes[idx].take().unwrap();
        self.free_list.push(idx);
        for fds in pipe.ancillary_fds {
            for fd in &fds {
                self.release_ancillary_resource_inner(fd);
            }
        }
    }

    /// Collect ancillary queues that cannot be reached from an externally
    /// owned receive endpoint. Queued socket descriptors form graph edges to
    /// their receive pipes; the mark phase preserves every transitively
    /// receivable cycle and the sweep drops only components with no root.
    fn collect_unreachable_ancillary(&mut self) {
        let mut reachable = Vec::new();
        reachable.resize(self.pipes.len(), false);
        let mut work = VecDeque::new();
        for (idx, pipe) in self.pipes.iter().enumerate() {
            if pipe.as_ref().is_some_and(PipeBuffer::has_external_reader) {
                reachable[idx] = true;
                work.push_back(idx);
            }
        }

        while let Some(carrier_idx) = work.pop_front() {
            let Some(pipe) = self.get(carrier_idx) else {
                continue;
            };
            for batch in &pipe.ancillary_fds {
                for fd in batch {
                    if fd.file_type != 1 {
                        continue;
                    }
                    let Some(socket) = fd.socket.as_ref() else {
                        continue;
                    };
                    if !socket.global_pipes {
                        continue;
                    }
                    let Some(recv_idx) = socket.recv_buf_idx else {
                        continue;
                    };
                    if recv_idx < reachable.len() && !reachable[recv_idx] {
                        reachable[recv_idx] = true;
                        work.push_back(recv_idx);
                    }
                }
            }
        }

        let mut dropped = Vec::new();
        for (idx, pipe) in self.pipes.iter_mut().enumerate() {
            if !reachable[idx] {
                if let Some(pipe) = pipe.as_mut() {
                    dropped.extend(pipe.ancillary_fds.drain(..));
                }
            }
        }
        for batch in dropped {
            for fd in &batch {
                self.release_ancillary_resource_inner(fd);
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

    fn in_flight_pipe_read_end(pipe_idx: usize) -> InFlightFd {
        InFlightFd {
            file_type: 0,
            status_flags: wasm_posix_shared::flags::O_RDONLY,
            host_handle: -((pipe_idx as i64) + 1),
            offset: 0,
            path: b"/dev/pipe".to_vec(),
            socket: None,
        }
    }

    fn in_flight_socket(send_idx: usize, recv_idx: usize) -> InFlightFd {
        InFlightFd {
            file_type: 1,
            status_flags: wasm_posix_shared::flags::O_RDWR,
            host_handle: -1,
            offset: 0,
            path: b"socket".to_vec(),
            socket: Some(InFlightSocket {
                domain: 0,
                sock_type: 0,
                protocol: 0,
                state: 3,
                send_buf_idx: Some(send_idx),
                recv_buf_idx: Some(recv_idx),
                global_pipes: true,
                shut_rd: false,
                shut_wr: false,
                bind_addr: [0; 4],
                bind_port: 0,
                peer_addr: [0; 4],
                peer_port: 0,
            }),
        }
    }

    fn close_external_endpoints(table: &mut PipeTable, indices: &[usize]) {
        for &idx in indices {
            if let Some(pipe) = table.get_mut(idx) {
                pipe.close_read_end();
                pipe.close_write_end();
            }
            table.free_if_closed(idx);
        }
    }

    #[test]
    fn scm_rights_reference_becomes_received_pipe_endpoint() {
        let mut table = PipeTable::new();
        let pipe_idx = table.alloc(PipeBuffer::new(64));
        let right = in_flight_pipe_read_end(pipe_idx);

        assert!(table.retain_ancillary_resources(core::slice::from_ref(&right)));
        table.adopt_ancillary_resource(&right);
        table.finish_ancillary_transition();
        table.get_mut(pipe_idx).unwrap().close_read_end();
        assert_eq!(table.get_mut(pipe_idx).unwrap().write(b"still connected"), 15);

        // Receiving transfers the retained reference to the new OFD. Its final
        // close, not installation, consumes that same reference.
        table.get_mut(pipe_idx).unwrap().close_write_end();
        let mut payload = [0u8; 15];
        assert_eq!(table.get_mut(pipe_idx).unwrap().read(&mut payload), 15);
        assert_eq!(&payload, b"still connected");
        table.get_mut(pipe_idx).unwrap().close_read_end();
        table.free_if_closed(pipe_idx);
        assert!(table.get(pipe_idx).is_none());
    }

    #[test]
    fn closing_carrier_releases_queued_pipe_endpoint() {
        let mut table = PipeTable::new();
        let pipe_idx = table.alloc(PipeBuffer::new(64));
        let carrier_idx = table.alloc(PipeBuffer::new(64));
        let right = in_flight_pipe_read_end(pipe_idx);

        assert!(table.queue_ancillary(carrier_idx, vec![right]));
        table.get_mut(pipe_idx).unwrap().close_read_end();
        assert_eq!(table.get_mut(pipe_idx).unwrap().write(b"held"), 4);

        table.get_mut(carrier_idx).unwrap().close_read_end();
        table.get_mut(carrier_idx).unwrap().close_write_end();
        table.free_if_closed(carrier_idx);
        assert_eq!(table.get_mut(pipe_idx).unwrap().write(b"released"), 0);

        table.get_mut(pipe_idx).unwrap().close_write_end();
        table.free_if_closed(pipe_idx);
        assert!(table.get(pipe_idx).is_none());
    }

    #[test]
    fn unreachable_self_socket_right_cycle_is_collected_and_slots_reused() {
        let mut table = PipeTable::new();

        for _ in 0..32 {
            let (carrier_idx, peer_send_idx) =
                table.alloc_pair(PipeBuffer::new(64), PipeBuffer::new(64));
            assert_eq!((carrier_idx, peer_send_idx), (0, 1));

            // The peer socket receives from carrier_idx. Queuing that peer on
            // carrier_idx creates the canonical SCM_RIGHTS self-cycle.
            let peer = in_flight_socket(peer_send_idx, carrier_idx);
            assert!(table.queue_ancillary(carrier_idx, vec![peer]));
            assert!(table.get(carrier_idx).unwrap().has_ancillary());

            close_external_endpoints(&mut table, &[carrier_idx, peer_send_idx]);
            assert_eq!(table.count_active(), 0);
        }
    }

    #[test]
    fn unreachable_cross_socket_right_cycle_is_collected() {
        let mut table = PipeTable::new();
        let (a_recv_idx, a_send_idx) =
            table.alloc_pair(PipeBuffer::new(64), PipeBuffer::new(64));
        let (b_recv_idx, b_send_idx) =
            table.alloc_pair(PipeBuffer::new(64), PipeBuffer::new(64));

        let a = in_flight_socket(a_send_idx, a_recv_idx);
        let b = in_flight_socket(b_send_idx, b_recv_idx);
        assert!(table.queue_ancillary(a_recv_idx, vec![b]));
        assert!(table.queue_ancillary(b_recv_idx, vec![a]));

        close_external_endpoints(
            &mut table,
            &[a_recv_idx, a_send_idx, b_recv_idx, b_send_idx],
        );
        assert_eq!(table.count_active(), 0);
    }
}
