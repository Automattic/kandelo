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
    /// For DRM prime-bo FDs: the bo sidecar, without which the fd arrives as a
    /// plain CharDevice and the receiver's `PRIME_FD_TO_HANDLE` import fails.
    pub prime_bo: Option<crate::ofd::PrimeBoState>,
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
    /// Index of this pipe in the PipeTable (for wakeup events).
    pipe_idx: u32,
    /// Ancillary data queue for SCM_RIGHTS FD passing.
    ///
    /// Each entry is `(stream_offset, fds)`: the batch of FDs sent with one
    /// sendmsg call, tagged with the byte-stream offset of the FIRST data byte
    /// of that send (Linux stream-socket SCM_RIGHTS semantics — ancillary data
    /// is attached to the first accompanying data byte). The receiver uses the
    /// offset to align FD delivery to the bytes actually returned so a single
    /// recvmsg never spans two sends' FDs.
    ancillary_fds: VecDeque<(u64, Vec<InFlightFd>)>,
    /// Total bytes ever written into this pipe (monotonic; never decremented on read).
    total_written: u64,
    /// Total bytes ever consumed from this pipe via `read` (monotonic).
    total_read: u64,
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
            pipe_idx: 0,
            ancillary_fds: VecDeque::new(),
            total_written: 0,
            total_read: 0,
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
        self.total_written += n as u64;
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
        self.total_read += n as u64;
        // Data consumed → pipe became writable
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
        n
    }

    /// Close one read end of the pipe. Decrements the read reference count.
    pub fn close_read_end(&mut self) {
        self.read_count = self.read_count.saturating_sub(1);
        // Read end closed → pipe became writable (writers get EPIPE/SIGPIPE)
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_WRITABLE);
    }

    /// Close one write end of the pipe. Decrements the write reference count.
    pub fn close_write_end(&mut self) {
        self.write_count = self.write_count.saturating_sub(1);
        // Write end closed → pipe became readable (readers get EOF)
        crate::wakeup::push(self.pipe_idx, crate::wakeup::WAKE_READABLE);
    }

    /// Add a reader reference (e.g., after fork or dup).
    pub fn add_reader(&mut self) {
        self.read_count += 1;
    }

    /// Add a writer reference (e.g., after fork or dup).
    pub fn add_writer(&mut self) {
        self.write_count += 1;
    }

    /// Returns true if the read end is still open (any readers remain).
    pub fn is_read_end_open(&self) -> bool {
        self.read_count > 0
    }

    /// Returns true if the write end is still open (any writers remain).
    pub fn is_write_end_open(&self) -> bool {
        self.write_count > 0
    }

    /// Returns true if both endpoints are closed and the pipe can be freed.
    pub fn is_fully_closed(&self) -> bool {
        self.read_count == 0 && self.write_count == 0
    }

    /// Total bytes ever written into this pipe (monotonic).
    pub fn total_written(&self) -> u64 {
        self.total_written
    }

    /// Total bytes ever consumed from this pipe via `read` (monotonic).
    pub fn total_read(&self) -> u64 {
        self.total_read
    }

    /// Push ancillary FDs (SCM_RIGHTS) to be delivered with the next recvmsg.
    ///
    /// `stream_offset` is the byte-stream position of the first data byte of the
    /// send carrying these FDs (typically `total_written() - bytes_sent`), so the
    /// receiver can align delivery to the bytes it actually returns.
    pub fn push_ancillary(&mut self, stream_offset: u64, fds: Vec<InFlightFd>) {
        if !fds.is_empty() {
            self.ancillary_fds.push_back((stream_offset, fds));
        }
    }

    /// Pop the front ancillary group's FDs (SCM_RIGHTS) for a recvmsg call.
    pub fn pop_ancillary(&mut self) -> Option<Vec<InFlightFd>> {
        self.ancillary_fds.pop_front().map(|(_, fds)| fds)
    }

    /// Stream byte-offset of the first data byte carrying the front (oldest)
    /// ancillary group, if any is queued.
    pub fn front_ancillary_offset(&self) -> Option<u64> {
        self.ancillary_fds.front().map(|(off, _)| *off)
    }

    /// Stream byte-offset of the ancillary group after the front one, if any.
    ///
    /// The receiver caps a delivering recvmsg at this offset so it never reads
    /// into the next send's data (which would strand that send's FDs).
    pub fn next_ancillary_offset(&self) -> Option<u64> {
        self.ancillary_fds.get(1).map(|(off, _)| *off)
    }

    /// Returns true if there are ancillary FDs pending delivery.
    pub fn has_ancillary(&self) -> bool {
        !self.ancillary_fds.is_empty()
    }

    /// Drain every still-queued ancillary group, returning the DRM prime-bo ids
    /// they carried. Called when the pipe is being freed so the caller can
    /// release the channel's in-flight bo refcount on FDs that were sent but
    /// never received (otherwise the bo — and its host SAB — would leak).
    pub fn take_pending_prime_bo_ids(&mut self) -> Vec<u32> {
        let mut ids = Vec::new();
        for (_off, group) in self.ancillary_fds.drain(..) {
            for fd in group {
                if let Some(pb) = fd.prime_bo {
                    ids.push(pb.bo_id);
                }
            }
        }
        ids
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

    fn dummy_fd(tag: u8) -> InFlightFd {
        InFlightFd {
            file_type: 4, // CharDevice — matches the DRM prime-fd shape
            status_flags: 0,
            host_handle: tag as i64,
            offset: 0,
            path: Vec::new(),
            socket: None,
            prime_bo: None,
        }
    }

    #[test]
    fn test_stream_byte_counters() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        assert_eq!(pipe.total_written(), 0);
        assert_eq!(pipe.total_read(), 0);

        pipe.write(b"hello"); // 5
        pipe.write(b"world!"); // +6 = 11
        assert_eq!(pipe.total_written(), 11);
        assert_eq!(pipe.total_read(), 0);

        let mut buf = [0u8; 4];
        pipe.read(&mut buf);
        assert_eq!(pipe.total_read(), 4);

        // peek must NOT advance total_read (it doesn't consume the stream).
        let mut pbuf = [0u8; 4];
        pipe.peek(&mut pbuf);
        assert_eq!(pipe.total_read(), 4);

        pipe.read(&mut buf);
        assert_eq!(pipe.total_read(), 8);
    }

    #[test]
    fn test_ancillary_offsets_fifo() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        assert!(!pipe.has_ancillary());
        assert_eq!(pipe.front_ancillary_offset(), None);
        assert_eq!(pipe.next_ancillary_offset(), None);

        // Two sends, each carrying one fd, at distinct stream offsets.
        pipe.push_ancillary(0, alloc::vec![dummy_fd(1)]);
        pipe.push_ancillary(12, alloc::vec![dummy_fd(2)]);

        assert!(pipe.has_ancillary());
        assert_eq!(pipe.front_ancillary_offset(), Some(0));
        assert_eq!(pipe.next_ancillary_offset(), Some(12));

        // Pop delivers the front group's fds in FIFO order and drops its offset.
        let g0 = pipe.pop_ancillary().expect("front group");
        assert_eq!(g0.len(), 1);
        assert_eq!(g0[0].host_handle, 1);
        assert_eq!(pipe.front_ancillary_offset(), Some(12));
        assert_eq!(pipe.next_ancillary_offset(), None);

        let g1 = pipe.pop_ancillary().expect("second group");
        assert_eq!(g1[0].host_handle, 2);
        assert!(!pipe.has_ancillary());
        assert_eq!(pipe.pop_ancillary().is_none(), true);
    }

    #[test]
    fn test_push_ancillary_ignores_empty() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        pipe.push_ancillary(5, Vec::new());
        assert!(!pipe.has_ancillary());
        assert_eq!(pipe.front_ancillary_offset(), None);
    }

    #[test]
    fn test_take_pending_prime_bo_ids_drains_undelivered() {
        let mut pipe = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        // A prime-bo fd carries a bo sidecar; a plain fd does not.
        let mut prime = dummy_fd(0);
        prime.prime_bo = Some(crate::ofd::PrimeBoState { bo_id: 42, cookie: 7 });
        pipe.push_ancillary(0, alloc::vec![prime]);
        pipe.push_ancillary(8, alloc::vec![dummy_fd(9)]); // no prime_bo → no id

        let ids = pipe.take_pending_prime_bo_ids();
        assert_eq!(ids, alloc::vec![42u32]);
        // Draining consumes every queued group.
        assert!(!pipe.has_ancillary());
        assert!(pipe.take_pending_prime_bo_ids().is_empty());
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
}
