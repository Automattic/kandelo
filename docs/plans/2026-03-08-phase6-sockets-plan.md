# Phase 6: Socket Infrastructure & I/O Multiplexing

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add POSIX socket API surface with kernel-internal Unix domain stream sockets (via socketpair) and poll() multiplexing. TCP socket stubs ready for future host delegation.

**Architecture:** Socket state tracked in per-process socket table (like pipes). Unix domain stream sockets use bidirectional ring buffers (reuse PipeBuffer). sys_read/sys_write refactored to dispatch on FileType instead of host_handle sign. poll() checks readiness across all fd types.

**Tech Stack:** Rust (no_std), wasm32-unknown-unknown target

---

## Design Decisions & POSIX Tradeoffs

### Decision 1: socketpair() over full AF_UNIX
**Chosen:** Implement socketpair() for Unix domain stream sockets. Full bind/listen/accept for AF_UNIX deferred.
**Rationale:** In a single-process kernel, there's no peer process to connect to via named Unix sockets. socketpair() creates a pre-connected bidirectional channel — useful for self-pipe tricks, testing, and future IPC when multi-process is added. Full AF_UNIX named sockets (bind to filesystem path, listen, accept) require multi-process coordination.
**Alternative:** Full AF_UNIX with named sockets. Would require a kernel-managed namespace and connection queue. Documented for Phase 3b integration.

### Decision 2: TCP as non-blocking stubs
**Chosen:** TCP (AF_INET) socket creation works, but bind/listen/accept/connect return ENOSYS. Full TCP requires host-delegated async I/O coordination.
**Rationale:** Node.js `net` module is async/event-driven. Making accept()/connect() synchronous requires worker_threads + Atomics.wait coordination — significant architectural work. The kernel-side API is fully defined so the host can be implemented later without kernel changes.
**Alternative:** Implement synchronous TCP wrappers using worker_threads. Would work but adds complexity to the host layer. Documented for future work.

### Decision 3: FileType-based dispatch in sys_read/sys_write
**Chosen:** Refactor sys_read/sys_write to dispatch on ofd.file_type instead of host_handle sign.
**Rationale:** The current host_handle < 0 check for pipes is implicit. With sockets added, we need Socket-specific dispatch too. FileType is explicit, correct, and extensible. The refactor is small: replace `if host_handle < 0` with `match ofd.file_type { Pipe => ..., Socket => ..., _ => host }`.
**Alternative:** Encode socket handles in a different negative range (e.g., -1_000_000). Works but is fragile and implicit.

### Decision 4: Socket handle encoding for Unix domain
**Chosen:** For kernel-internal sockets (Unix domain), host_handle stores -(socket_idx + 1). For host-delegated sockets (future TCP), host_handle stores the actual host handle (positive).
**Rationale:** Mirrors the pipe convention. The FileType check distinguishes Socket from Pipe, so there's no ambiguity even though both use negative handles.

### Decision 5: poll() over select()
**Chosen:** Implement poll() as the primary multiplexing mechanism. select() can be implemented in userspace on top of poll().
**Rationale:** poll() has a cleaner interface (no fd_set size limit, simpler struct). select() has the FD_SETSIZE=1024 constraint and requires bitmap manipulation. Most modern programs prefer poll() or epoll().
**Alternative:** Implement both. select() can be added later if needed.

### Decision 6: Bidirectional socket buffers
**Chosen:** Each connected socket pair shares two PipeBuffers: one for each direction. Socket A writes to buf_ab, Socket B reads from buf_ab. Socket B writes to buf_ba, Socket A reads from buf_ba.
**Rationale:** Reuses the proven PipeBuffer ring buffer. Each socket only needs to know its send buffer index and recv buffer index.

---

## Task 1: Shared Crate — Socket Constants & Types

**Files:**
- Modify: `crates/shared/src/lib.rs`

**Step 1: Add socket syscall numbers**

Add to the Syscall enum after Mprotect=49:

```rust
Socket = 50,
Bind = 51,
Listen = 52,
Accept = 53,
Connect = 54,
Send = 55,
Recv = 56,
Shutdown = 57,
Getsockopt = 58,
Setsockopt = 59,
Poll = 60,
Socketpair = 61,
Sendto = 62,
Recvfrom = 63,
```

Update from_u32 to handle 50-63.

**Step 2: Add socket constants module**

```rust
pub mod socket {
    // Address families
    pub const AF_UNIX: u32 = 1;
    pub const AF_INET: u32 = 2;
    pub const AF_INET6: u32 = 10;

    // Socket types
    pub const SOCK_STREAM: u32 = 1;
    pub const SOCK_DGRAM: u32 = 2;
    pub const SOCK_NONBLOCK: u32 = 0o4000;  // Can be OR'd with type
    pub const SOCK_CLOEXEC: u32 = 0o2000000; // Can be OR'd with type

    // Socket options level
    pub const SOL_SOCKET: u32 = 1;

    // Socket options
    pub const SO_REUSEADDR: u32 = 2;
    pub const SO_ERROR: u32 = 4;
    pub const SO_KEEPALIVE: u32 = 9;
    pub const SO_RCVBUF: u32 = 8;
    pub const SO_SNDBUF: u32 = 7;
    pub const SO_TYPE: u32 = 3;
    pub const SO_DOMAIN: u32 = 39;
    pub const SO_ACCEPTCONN: u32 = 30;

    // Shutdown how
    pub const SHUT_RD: u32 = 0;
    pub const SHUT_WR: u32 = 1;
    pub const SHUT_RDWR: u32 = 2;

    // MSG flags for send/recv
    pub const MSG_PEEK: u32 = 2;
    pub const MSG_DONTWAIT: u32 = 64;
    pub const MSG_NOSIGNAL: u32 = 0x4000;
}
```

**Step 3: Add poll constants module**

```rust
pub mod poll {
    pub const POLLIN: i16 = 0x0001;
    pub const POLLPRI: i16 = 0x0002;
    pub const POLLOUT: i16 = 0x0004;
    pub const POLLERR: i16 = 0x0008;
    pub const POLLHUP: i16 = 0x0010;
    pub const POLLNVAL: i16 = 0x0020;
}
```

**Step 4: Add repr(C) WasmPollFd struct**

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WasmPollFd {
    pub fd: i32,
    pub events: i16,
    pub revents: i16,
}
```

**Step 5: Add socket-related errno values**

Add to Errno enum (if not present): ENOTSOCK=88, ECONNREFUSED=111, ECONNRESET=104, ECONNABORTED=103, EISCONN=106, ENOTCONN=107, ESHUTDOWN=108, EADDRINUSE=98, EADDRNOTAVAIL=99, ENETUNREACH=101, EAFNOSUPPORT=97, EPROTOTYPE=91, ENOPROTOOPT=92, EPROTONOSUPPORT=93, EOPNOTSUPP=95, EDESTADDRREQ=89, EMSGSIZE=90, EALREADY=114, EINPROGRESS=115.

**Step 6: Commit**

```
git add crates/shared/src/lib.rs
git commit -m "feat: add socket/poll syscall numbers, constants, and types"
```

---

## Task 2: Socket Module — Kernel-Side State Management

**Files:**
- Create: `crates/kernel/src/socket.rs`
- Modify: `crates/kernel/src/lib.rs` (add `mod socket;`)

**Step 1: Write tests for socket state**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_socket_info() {
        let sock = SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0);
        assert_eq!(sock.domain, SocketDomain::Unix);
        assert_eq!(sock.sock_type, SocketType::Stream);
        assert_eq!(sock.state, SocketState::Unbound);
        assert_eq!(sock.peer_idx, None);
    }

    #[test]
    fn test_socket_table_alloc() {
        let mut table = SocketTable::new();
        let idx = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        assert_eq!(idx, 0);
        assert!(table.get(idx).is_some());
    }

    #[test]
    fn test_socket_table_free() {
        let mut table = SocketTable::new();
        let idx = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        table.free(idx);
        assert!(table.get(idx).is_none());
    }

    #[test]
    fn test_socket_table_slot_reuse() {
        let mut table = SocketTable::new();
        let idx0 = table.alloc(SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0));
        table.free(idx0);
        let idx1 = table.alloc(SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0));
        assert_eq!(idx0, idx1); // Slot reused
    }

    #[test]
    fn test_socket_state_transitions() {
        let mut sock = SocketInfo::new(SocketDomain::Unix, SocketType::Stream, 0);
        assert_eq!(sock.state, SocketState::Unbound);
        sock.state = SocketState::Connected;
        assert_eq!(sock.state, SocketState::Connected);
    }
}
```

**Step 2: Run tests — expect failures**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel -- socket`
Expected: compilation errors (module doesn't exist yet)

**Step 3: Implement socket.rs**

```rust
extern crate alloc;

use alloc::vec::Vec;

/// Socket address family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketDomain {
    Unix,
    Inet,
    Inet6,
}

/// Socket type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketType {
    Stream,
    Dgram,
}

/// Socket connection state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketState {
    Unbound,
    Bound,
    Listening,
    Connected,
    Closed,
}

/// Per-socket kernel state.
pub struct SocketInfo {
    pub domain: SocketDomain,
    pub sock_type: SocketType,
    pub protocol: u32,
    pub state: SocketState,
    /// Index of peer socket (for connected Unix domain pairs).
    pub peer_idx: Option<usize>,
    /// Index into Process.pipes for the receive buffer.
    pub recv_buf_idx: Option<usize>,
    /// Index into Process.pipes for the send buffer.
    pub send_buf_idx: Option<usize>,
    /// Whether the read half has been shut down.
    pub shut_rd: bool,
    /// Whether the write half has been shut down.
    pub shut_wr: bool,
}

impl SocketInfo {
    pub fn new(domain: SocketDomain, sock_type: SocketType, protocol: u32) -> Self {
        SocketInfo {
            domain,
            sock_type,
            protocol,
            state: SocketState::Unbound,
            peer_idx: None,
            recv_buf_idx: None,
            send_buf_idx: None,
            shut_rd: false,
            shut_wr: false,
        }
    }
}

/// Table of socket state, indexed by socket slot.
pub struct SocketTable {
    entries: Vec<Option<SocketInfo>>,
}

impl SocketTable {
    pub fn new() -> Self {
        SocketTable {
            entries: Vec::new(),
        }
    }

    /// Allocate a slot for a new socket. Reuses freed slots.
    pub fn alloc(&mut self, info: SocketInfo) -> usize {
        for i in 0..self.entries.len() {
            if self.entries[i].is_none() {
                self.entries[i] = Some(info);
                return i;
            }
        }
        let idx = self.entries.len();
        self.entries.push(Some(info));
        idx
    }

    /// Free a socket slot.
    pub fn free(&mut self, idx: usize) {
        if idx < self.entries.len() {
            self.entries[idx] = None;
        }
    }

    /// Get a reference to socket info at `idx`.
    pub fn get(&self, idx: usize) -> Option<&SocketInfo> {
        self.entries.get(idx).and_then(|s| s.as_ref())
    }

    /// Get a mutable reference to socket info at `idx`.
    pub fn get_mut(&mut self, idx: usize) -> Option<&mut SocketInfo> {
        self.entries.get_mut(idx).and_then(|s| s.as_mut())
    }
}
```

**Step 4: Add `mod socket;` to lib.rs**

**Step 5: Run tests — expect pass**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel -- socket`
Expected: 5 tests pass

**Step 6: Commit**

```
git add crates/kernel/src/socket.rs crates/kernel/src/lib.rs
git commit -m "feat: add socket state management module"
```

---

## Task 3: Add Socket Table to Process + Refactor sys_read/sys_write

**Files:**
- Modify: `crates/kernel/src/process.rs` — add `sockets: SocketTable`
- Modify: `crates/kernel/src/syscalls.rs` — refactor sys_read/sys_write to dispatch on FileType

**Step 1: Add SocketTable to Process**

```rust
use crate::socket::SocketTable;

// In Process struct, add:
pub sockets: SocketTable,

// In Process::new(), add:
sockets: SocketTable::new(),
```

**Step 2: Refactor sys_read to dispatch on FileType**

Replace the `if host_handle < 0` block with:

```rust
use crate::ofd::FileType;

pub fn sys_read(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    let access_mode = ofd.status_flags & O_ACCMODE;
    if access_mode == O_WRONLY {
        return Err(Errno::EBADF);
    }

    let host_handle = ofd.host_handle;
    let file_type = ofd.file_type;

    match file_type {
        FileType::Pipe => {
            let pipe_idx = (-(host_handle + 1)) as usize;
            let pipe = proc.pipes.get_mut(pipe_idx)
                .and_then(|p| p.as_mut())
                .ok_or(Errno::EBADF)?;
            Ok(pipe.read(buf))
        }
        FileType::Socket => {
            let sock_idx = (-(host_handle + 1)) as usize;
            let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
            if sock.shut_rd {
                return Ok(0); // EOF on shutdown read
            }
            let recv_buf_idx = sock.recv_buf_idx.ok_or(Errno::ENOTCONN)?;
            let pipe = proc.pipes.get_mut(recv_buf_idx)
                .and_then(|p| p.as_mut())
                .ok_or(Errno::EBADF)?;
            let n = pipe.read(buf);
            if n == 0 && !pipe.is_write_end_open() {
                return Ok(0); // Peer closed
            }
            Ok(n)
        }
        _ => {
            // Host-delegated read
            let n = host.host_read(host_handle, buf)?;
            if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                ofd.offset += n as i64;
            }
            Ok(n)
        }
    }
}
```

**Step 3: Refactor sys_write to dispatch on FileType**

```rust
pub fn sys_write(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &[u8],
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd_idx = entry.ofd_ref.0;
    let ofd = proc.ofd_table.get(ofd_idx).ok_or(Errno::EBADF)?;

    let access_mode = ofd.status_flags & O_ACCMODE;
    if access_mode == O_RDONLY {
        return Err(Errno::EBADF);
    }

    let host_handle = ofd.host_handle;
    let file_type = ofd.file_type;

    match file_type {
        FileType::Pipe => {
            let pipe_idx = (-(host_handle + 1)) as usize;
            let pipe = proc.pipes.get_mut(pipe_idx)
                .and_then(|p| p.as_mut())
                .ok_or(Errno::EBADF)?;
            if !pipe.is_read_end_open() {
                return Err(Errno::EPIPE);
            }
            Ok(pipe.write(buf))
        }
        FileType::Socket => {
            let sock_idx = (-(host_handle + 1)) as usize;
            let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
            if sock.shut_wr {
                return Err(Errno::EPIPE);
            }
            let send_buf_idx = sock.send_buf_idx.ok_or(Errno::ENOTCONN)?;
            let pipe = proc.pipes.get_mut(send_buf_idx)
                .and_then(|p| p.as_mut())
                .ok_or(Errno::EBADF)?;
            if !pipe.is_read_end_open() {
                return Err(Errno::EPIPE); // Peer closed
            }
            Ok(pipe.write(buf))
        }
        _ => {
            // Host-delegated write
            let n = host.host_write(host_handle, buf)?;
            if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                ofd.offset += n as i64;
            }
            Ok(n)
        }
    }
}
```

**Step 4: Update sys_lseek to also reject sockets**

Add `FileType::Socket` alongside `FileType::Pipe` in the ESPIPE check.

**Step 5: Run existing tests — all should still pass**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`
Expected: all 126 existing tests pass (refactor preserves behavior)

**Step 6: Commit**

```
git add crates/kernel/src/process.rs crates/kernel/src/syscalls.rs
git commit -m "refactor: dispatch sys_read/sys_write on FileType, add SocketTable to Process"
```

---

## Task 4: sys_socket and sys_socketpair Syscall Handlers

**Files:**
- Modify: `crates/kernel/src/syscalls.rs`

**Step 1: Write tests**

```rust
#[test]
fn test_socket_creation() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
    assert!(fd >= 3); // After stdio
    // Verify OFD is Socket type
    let entry = proc.fd_table.get(fd).unwrap();
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).unwrap();
    assert_eq!(ofd.file_type, FileType::Socket);
}

#[test]
fn test_socket_unsupported_domain() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let result = sys_socket(&mut proc, &mut host, 999, SOCK_STREAM, 0);
    assert_eq!(result, Err(Errno::EAFNOSUPPORT));
}

#[test]
fn test_socket_unsupported_type() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let result = sys_socket(&mut proc, &mut host, AF_UNIX, 999, 0);
    assert_eq!(result, Err(Errno::EPROTOTYPE));
}

#[test]
fn test_socketpair_unix_stream() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
    assert!(fd0 >= 3);
    assert!(fd1 >= 3);
    assert_ne!(fd0, fd1);

    // Write through fd0, read from fd1
    let n = sys_write(&mut proc, &mut host, fd0, b"hello").unwrap();
    assert_eq!(n, 5);
    let mut buf = [0u8; 5];
    let n = sys_read(&mut proc, &mut host, fd1, &mut buf).unwrap();
    assert_eq!(n, 5);
    assert_eq!(&buf, b"hello");

    // Write through fd1, read from fd0
    let n = sys_write(&mut proc, &mut host, fd1, b"world").unwrap();
    assert_eq!(n, 5);
    let mut buf = [0u8; 5];
    let n = sys_read(&mut proc, &mut host, fd0, &mut buf).unwrap();
    assert_eq!(n, 5);
    assert_eq!(&buf, b"world");
}

#[test]
fn test_socketpair_close_one_end() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

    // Close fd1
    sys_close(&mut proc, &mut host, fd1).unwrap();

    // Write to fd0 should return EPIPE (peer closed)
    let result = sys_write(&mut proc, &mut host, fd0, b"test");
    assert_eq!(result, Err(Errno::EPIPE));

    // Read from fd0 should return 0 (EOF)
    let mut buf = [0u8; 4];
    let n = sys_read(&mut proc, &mut host, fd0, &mut buf).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn test_socketpair_not_unix() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let result = sys_socketpair(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0);
    assert_eq!(result, Err(Errno::EAFNOSUPPORT));
}
```

**Step 2: Run tests — expect failures**

**Step 3: Implement sys_socket**

```rust
pub fn sys_socket(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    domain: u32,
    sock_type: u32,
    protocol: u32,
) -> Result<i32, Errno> {
    use crate::socket::{SocketDomain, SocketInfo, SocketType};
    use wasm_posix_shared::socket::*;

    // Parse domain
    let dom = match domain {
        AF_UNIX => SocketDomain::Unix,
        AF_INET => SocketDomain::Inet,
        AF_INET6 => SocketDomain::Inet6,
        _ => return Err(Errno::EAFNOSUPPORT),
    };

    // Parse socket type (strip SOCK_NONBLOCK and SOCK_CLOEXEC flags)
    let base_type = sock_type & !(SOCK_NONBLOCK | SOCK_CLOEXEC);
    let stype = match base_type {
        SOCK_STREAM => SocketType::Stream,
        SOCK_DGRAM => SocketType::Dgram,
        _ => return Err(Errno::EPROTOTYPE),
    };

    // Create socket info
    let sock = SocketInfo::new(dom, stype, protocol);
    let sock_idx = proc.sockets.alloc(sock);

    // Create OFD with Socket file type
    let mut status_flags = O_RDWR;
    if sock_type & SOCK_NONBLOCK != 0 {
        status_flags |= O_NONBLOCK;
    }
    let host_handle = -((sock_idx as i64) + 1);
    let ofd_idx = proc.ofd_table.create(FileType::Socket, status_flags, host_handle);

    // Allocate fd
    let mut fd_flags = 0u32;
    if sock_type & SOCK_CLOEXEC != 0 {
        fd_flags = FD_CLOEXEC;
    }
    let fd = proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags);

    Ok(fd)
}
```

**Step 4: Implement sys_socketpair**

```rust
pub fn sys_socketpair(
    proc: &mut Process,
    _host: &mut dyn HostIO,
    domain: u32,
    sock_type: u32,
    protocol: u32,
) -> Result<(i32, i32), Errno> {
    use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};
    use wasm_posix_shared::socket::*;

    // socketpair only supports AF_UNIX
    if domain != AF_UNIX {
        return Err(Errno::EAFNOSUPPORT);
    }

    let base_type = sock_type & !(SOCK_NONBLOCK | SOCK_CLOEXEC);
    let stype = match base_type {
        SOCK_STREAM => SocketType::Stream,
        _ => return Err(Errno::EPROTOTYPE),
    };

    // Allocate two ring buffers (bidirectional): buf_ab (A→B) and buf_ba (B→A)
    let buf_ab_idx = {
        let buf = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        let idx = proc.pipes.len();
        proc.pipes.push(Some(buf));
        idx
    };
    let buf_ba_idx = {
        let buf = PipeBuffer::new(DEFAULT_PIPE_CAPACITY);
        let idx = proc.pipes.len();
        proc.pipes.push(Some(buf));
        idx
    };

    // Create socket A: sends to buf_ab, receives from buf_ba
    let mut sock_a = SocketInfo::new(SocketDomain::Unix, stype, protocol);
    sock_a.state = SocketState::Connected;
    sock_a.send_buf_idx = Some(buf_ab_idx);
    sock_a.recv_buf_idx = Some(buf_ba_idx);

    // Create socket B: sends to buf_ba, receives from buf_ab
    let mut sock_b = SocketInfo::new(SocketDomain::Unix, stype, protocol);
    sock_b.state = SocketState::Connected;
    sock_b.send_buf_idx = Some(buf_ba_idx);
    sock_b.recv_buf_idx = Some(buf_ab_idx);

    let sock_a_idx = proc.sockets.alloc(sock_a);
    let sock_b_idx = proc.sockets.alloc(sock_b);

    // Set peer indices
    proc.sockets.get_mut(sock_a_idx).unwrap().peer_idx = Some(sock_b_idx);
    proc.sockets.get_mut(sock_b_idx).unwrap().peer_idx = Some(sock_a_idx);

    // Create OFDs
    let mut status_flags = O_RDWR;
    if sock_type & SOCK_NONBLOCK != 0 {
        status_flags |= O_NONBLOCK;
    }

    let handle_a = -((sock_a_idx as i64) + 1);
    let handle_b = -((sock_b_idx as i64) + 1);
    let ofd_a = proc.ofd_table.create(FileType::Socket, status_flags, handle_a);
    let ofd_b = proc.ofd_table.create(FileType::Socket, status_flags, handle_b);

    // Allocate fds
    let mut fd_flags = 0u32;
    if sock_type & SOCK_CLOEXEC != 0 {
        fd_flags = FD_CLOEXEC;
    }
    let fd0 = proc.fd_table.alloc(OpenFileDescRef(ofd_a), fd_flags);
    let fd1 = proc.fd_table.alloc(OpenFileDescRef(ofd_b), fd_flags);

    Ok((fd0, fd1))
}
```

**Step 5: Extend sys_close to clean up socket state**

In the existing sys_close, after dec_ref returns true (OFD freed), add socket cleanup:

```rust
// If this was a socket, close its pipe buffers
if file_type == FileType::Socket && host_handle < 0 {
    let sock_idx = (-(host_handle + 1)) as usize;
    if let Some(sock) = proc.sockets.get(sock_idx) {
        // Close write end of send buffer
        if let Some(send_idx) = sock.send_buf_idx {
            if let Some(Some(pipe)) = proc.pipes.get_mut(send_idx) {
                pipe.close_write_end();
            }
        }
        // Close read end of recv buffer
        if let Some(recv_idx) = sock.recv_buf_idx {
            if let Some(Some(pipe)) = proc.pipes.get_mut(recv_idx) {
                pipe.close_read_end();
            }
        }
    }
    proc.sockets.free(sock_idx);
}
```

**Step 6: Run tests — all pass**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`
Expected: all tests pass (existing + 6 new socket tests)

**Step 7: Commit**

```
git add crates/kernel/src/syscalls.rs
git commit -m "feat: implement sys_socket and sys_socketpair with Unix domain stream support"
```

---

## Task 5: Socket Utility Syscalls — shutdown, send, recv, getsockopt, setsockopt

**Files:**
- Modify: `crates/kernel/src/syscalls.rs`

**Step 1: Write tests**

```rust
#[test]
fn test_shutdown_read() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
    sys_shutdown(&mut proc, fd0, SHUT_RD).unwrap();
    // Read from fd0 should return 0
    let mut buf = [0u8; 4];
    let n = sys_read(&mut proc, &mut host, fd0, &mut buf).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn test_shutdown_write() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
    sys_shutdown(&mut proc, fd0, SHUT_WR).unwrap();
    // Write to fd0 should return EPIPE
    let result = sys_write(&mut proc, &mut host, fd0, b"test");
    assert_eq!(result, Err(Errno::EPIPE));
}

#[test]
fn test_send_recv() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

    let n = sys_send(&mut proc, &mut host, fd0, b"test", 0).unwrap();
    assert_eq!(n, 4);

    let mut buf = [0u8; 4];
    let n = sys_recv(&mut proc, &mut host, fd1, &mut buf, 0).unwrap();
    assert_eq!(n, 4);
    assert_eq!(&buf, b"test");
}

#[test]
fn test_send_not_connected() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
    let result = sys_send(&mut proc, &mut host, fd, b"test", 0);
    assert_eq!(result, Err(Errno::ENOTCONN));
}

#[test]
fn test_getsockopt_so_type() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
    let val = sys_getsockopt(&mut proc, fd, SOL_SOCKET, SO_TYPE).unwrap();
    assert_eq!(val, SOCK_STREAM);
}

#[test]
fn test_getsockopt_so_domain() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
    let val = sys_getsockopt(&mut proc, fd, SOL_SOCKET, SO_DOMAIN).unwrap();
    assert_eq!(val, AF_UNIX);
}

#[test]
fn test_getsockopt_not_socket() {
    let mut proc = Process::new(1);
    // fd 0 is stdin (CharDevice)
    let result = sys_getsockopt(&mut proc, 0, SOL_SOCKET, SO_TYPE);
    assert_eq!(result, Err(Errno::ENOTSOCK));
}

#[test]
fn test_shutdown_not_socket() {
    let mut proc = Process::new(1);
    let result = sys_shutdown(&mut proc, 0, SHUT_RDWR);
    assert_eq!(result, Err(Errno::ENOTSOCK));
}
```

**Step 2: Implement sys_shutdown**

```rust
pub fn sys_shutdown(proc: &mut Process, fd: i32, how: u32) -> Result<(), Errno> {
    use wasm_posix_shared::socket::*;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;

    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }

    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;

    match how {
        SHUT_RD => {
            sock.shut_rd = true;
        }
        SHUT_WR => {
            sock.shut_wr = true;
            // Close write end of send buffer
            if let Some(send_idx) = sock.send_buf_idx {
                if let Some(Some(pipe)) = proc.pipes.get_mut(send_idx) {
                    pipe.close_write_end();
                }
            }
        }
        SHUT_RDWR => {
            sock.shut_rd = true;
            sock.shut_wr = true;
            if let Some(send_idx) = sock.send_buf_idx {
                if let Some(Some(pipe)) = proc.pipes.get_mut(send_idx) {
                    pipe.close_write_end();
                }
            }
            if let Some(recv_idx) = sock.recv_buf_idx {
                if let Some(Some(pipe)) = proc.pipes.get_mut(recv_idx) {
                    pipe.close_read_end();
                }
            }
        }
        _ => return Err(Errno::EINVAL),
    }
    Ok(())
}
```

**Step 3: Implement sys_send and sys_recv**

```rust
pub fn sys_send(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &[u8],
    _flags: u32,
) -> Result<usize, Errno> {
    // send() on a connected socket is equivalent to write()
    // (flags like MSG_NOSIGNAL are noted but simplified for now)
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    if sock.state != SocketState::Connected {
        return Err(Errno::ENOTCONN);
    }
    // Delegate to sys_write for the actual data transfer
    sys_write(proc, host, fd, buf)
}

pub fn sys_recv(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
    _flags: u32,
) -> Result<usize, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    if sock.state != SocketState::Connected {
        return Err(Errno::ENOTCONN);
    }
    sys_read(proc, host, fd, buf)
}
```

**Step 4: Implement sys_getsockopt and sys_setsockopt**

```rust
pub fn sys_getsockopt(
    proc: &mut Process,
    fd: i32,
    level: u32,
    optname: u32,
) -> Result<u32, Errno> {
    use wasm_posix_shared::socket::*;
    use crate::socket::{SocketDomain, SocketState, SocketType};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }

    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    if level != SOL_SOCKET {
        return Err(Errno::ENOPROTOOPT);
    }

    match optname {
        SO_TYPE => Ok(match sock.sock_type {
            SocketType::Stream => SOCK_STREAM,
            SocketType::Dgram => SOCK_DGRAM,
        }),
        SO_DOMAIN => Ok(match sock.domain {
            SocketDomain::Unix => AF_UNIX,
            SocketDomain::Inet => AF_INET,
            SocketDomain::Inet6 => AF_INET6,
        }),
        SO_ERROR => Ok(0), // No pending error
        SO_ACCEPTCONN => Ok(if sock.state == SocketState::Listening { 1 } else { 0 }),
        SO_RCVBUF | SO_SNDBUF => Ok(DEFAULT_PIPE_CAPACITY as u32),
        _ => Err(Errno::ENOPROTOOPT),
    }
}

pub fn sys_setsockopt(
    proc: &mut Process,
    fd: i32,
    level: u32,
    optname: u32,
    _value: u32,
) -> Result<(), Errno> {
    use wasm_posix_shared::socket::*;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }

    if level != SOL_SOCKET {
        return Err(Errno::ENOPROTOOPT);
    }

    // For now, accept known options silently (no-op for most)
    match optname {
        SO_REUSEADDR | SO_KEEPALIVE | SO_RCVBUF | SO_SNDBUF => Ok(()),
        _ => Err(Errno::ENOPROTOOPT),
    }
}
```

**Step 5: Run tests**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`
Expected: all tests pass

**Step 6: Commit**

```
git add crates/kernel/src/syscalls.rs
git commit -m "feat: implement shutdown, send, recv, getsockopt, setsockopt"
```

---

## Task 6: Stub Syscalls — bind, listen, accept, connect, sendto, recvfrom

**Files:**
- Modify: `crates/kernel/src/syscalls.rs`

These are stubs that validate basic arguments but return ENOSYS for network operations (deferred until host TCP backend is implemented).

**Step 1: Write tests**

```rust
#[test]
fn test_bind_enosys_for_inet() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
    let result = sys_bind(&mut proc, fd, &[0u8; 16]);
    assert_eq!(result, Err(Errno::ENOSYS));
}

#[test]
fn test_bind_enotsock() {
    let mut proc = Process::new(1);
    let result = sys_bind(&mut proc, 0, &[0u8; 16]); // stdin
    assert_eq!(result, Err(Errno::ENOTSOCK));
}

#[test]
fn test_listen_enosys() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
    let result = sys_listen(&mut proc, fd, 5);
    assert_eq!(result, Err(Errno::ENOSYS));
}

#[test]
fn test_accept_enosys() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
    let result = sys_accept(&mut proc, &mut host, fd);
    assert_eq!(result, Err(Errno::ENOSYS));
}

#[test]
fn test_connect_enosys() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
    let result = sys_connect(&mut proc, &mut host, fd, &[0u8; 16]);
    assert_eq!(result, Err(Errno::ENOSYS));
}
```

**Step 2: Implement stubs**

```rust
pub fn sys_bind(proc: &mut Process, fd: i32, _addr: &[u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    // Network binding requires host support
    Err(Errno::ENOSYS)
}

pub fn sys_listen(proc: &mut Process, fd: i32, _backlog: u32) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::ENOSYS)
}

pub fn sys_accept(proc: &mut Process, _host: &mut dyn HostIO, fd: i32) -> Result<i32, Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::ENOSYS)
}

pub fn sys_connect(proc: &mut Process, _host: &mut dyn HostIO, fd: i32, _addr: &[u8]) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::ENOSYS)
}

pub fn sys_sendto(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &[u8],
    flags: u32,
    _addr: &[u8],
) -> Result<usize, Errno> {
    // For connected sockets, sendto ignores addr and delegates to send
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::ENOSYS)
}

pub fn sys_recvfrom(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
    flags: u32,
    _addr_buf: &mut [u8],
) -> Result<(usize, usize), Errno> {
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    Err(Errno::ENOSYS)
}
```

**Step 3: Run tests**

**Step 4: Commit**

```
git add crates/kernel/src/syscalls.rs
git commit -m "feat: add stub syscalls for bind, listen, accept, connect, sendto, recvfrom"
```

---

## Task 7: sys_poll — I/O Multiplexing

**Files:**
- Modify: `crates/kernel/src/syscalls.rs`

**Step 1: Write tests**

```rust
#[test]
fn test_poll_regular_file_always_ready() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    // stdout (fd 1) should be ready for writing
    let mut pollfd = WasmPollFd { fd: 1, events: POLLOUT, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 1);
    assert_ne!(pollfd.revents & POLLOUT, 0);
}

#[test]
fn test_poll_pipe_readable() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

    // Pipe is empty — not readable yet
    let mut pollfd = WasmPollFd { fd: read_fd, events: POLLIN, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 0);
    assert_eq!(pollfd.revents, 0);

    // Write data into pipe
    sys_write(&mut proc, &mut host, write_fd, b"data").unwrap();

    // Now pipe should be readable
    let mut pollfd = WasmPollFd { fd: read_fd, events: POLLIN, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 1);
    assert_ne!(pollfd.revents & POLLIN, 0);
}

#[test]
fn test_poll_pipe_writable() {
    let mut proc = Process::new(1);
    let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

    // Pipe has space — writable
    let mut pollfd = WasmPollFd { fd: write_fd, events: POLLOUT, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 1);
    assert_ne!(pollfd.revents & POLLOUT, 0);
}

#[test]
fn test_poll_pipe_hangup() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (read_fd, write_fd) = sys_pipe(&mut proc).unwrap();

    // Close write end
    sys_close(&mut proc, &mut host, write_fd).unwrap();

    // Read end should get POLLHUP
    let mut pollfd = WasmPollFd { fd: read_fd, events: POLLIN, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 1);
    assert_ne!(pollfd.revents & POLLHUP, 0);
}

#[test]
fn test_poll_invalid_fd() {
    let mut proc = Process::new(1);
    let mut pollfd = WasmPollFd { fd: 99, events: POLLIN, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 1);
    assert_ne!(pollfd.revents & POLLNVAL, 0);
}

#[test]
fn test_poll_socket_pair() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

    // Socket is writable (send buffer has space)
    let mut pollfd = WasmPollFd { fd: fd0, events: POLLOUT, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 1);
    assert_ne!(pollfd.revents & POLLOUT, 0);

    // Socket is not readable (no data yet)
    let mut pollfd = WasmPollFd { fd: fd0, events: POLLIN, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 0);

    // Write to fd1, now fd0 is readable
    sys_write(&mut proc, &mut host, fd1, b"x").unwrap();
    let mut pollfd = WasmPollFd { fd: fd0, events: POLLIN, revents: 0 };
    let n = sys_poll(&mut proc, core::slice::from_mut(&mut pollfd), 0).unwrap();
    assert_eq!(n, 1);
    assert_ne!(pollfd.revents & POLLIN, 0);
}

#[test]
fn test_poll_multiple_fds() {
    let mut proc = Process::new(1);
    let mut host = MockHostIO::new();
    let (fd0, fd1) = sys_socketpair(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();

    // Poll stdout (writable) and socket read end (not readable)
    let mut pollfds = [
        WasmPollFd { fd: 1, events: POLLOUT, revents: 0 },
        WasmPollFd { fd: fd0, events: POLLIN, revents: 0 },
    ];
    let n = sys_poll(&mut proc, &mut pollfds, 0).unwrap();
    assert_eq!(n, 1); // Only stdout ready
    assert_ne!(pollfds[0].revents & POLLOUT, 0);
    assert_eq!(pollfds[1].revents, 0);
}
```

**Step 2: Implement sys_poll**

```rust
pub fn sys_poll(
    proc: &mut Process,
    fds: &mut [WasmPollFd],
    _timeout_ms: i32,
) -> Result<i32, Errno> {
    use wasm_posix_shared::poll::*;

    let mut ready_count = 0i32;

    for pollfd in fds.iter_mut() {
        pollfd.revents = 0;

        // Check if fd is valid
        let entry = match proc.fd_table.get(pollfd.fd) {
            Ok(e) => e,
            Err(_) => {
                pollfd.revents = POLLNVAL;
                ready_count += 1;
                continue;
            }
        };

        let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
            Some(o) => o,
            None => {
                pollfd.revents = POLLNVAL;
                ready_count += 1;
                continue;
            }
        };

        let mut revents: i16 = 0;

        match ofd.file_type {
            FileType::Regular | FileType::CharDevice | FileType::Directory => {
                // Regular files and char devices are always ready
                if pollfd.events & POLLIN != 0 {
                    revents |= POLLIN;
                }
                if pollfd.events & POLLOUT != 0 {
                    revents |= POLLOUT;
                }
            }
            FileType::Pipe => {
                let pipe_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(Some(pipe)) = proc.pipes.get(pipe_idx) {
                    if pollfd.events & POLLIN != 0 && pipe.available() > 0 {
                        revents |= POLLIN;
                    }
                    if pollfd.events & POLLOUT != 0 && pipe.free_space() > 0 {
                        revents |= POLLOUT;
                    }
                    // Check for hangup
                    if !pipe.is_write_end_open() {
                        revents |= POLLHUP;
                    }
                }
            }
            FileType::Socket => {
                let sock_idx = (-(ofd.host_handle + 1)) as usize;
                if let Some(sock) = proc.sockets.get(sock_idx) {
                    // Check recv buffer for readability
                    if let Some(recv_idx) = sock.recv_buf_idx {
                        if let Some(Some(pipe)) = proc.pipes.get(recv_idx) {
                            if pollfd.events & POLLIN != 0 && pipe.available() > 0 {
                                revents |= POLLIN;
                            }
                            if !pipe.is_write_end_open() {
                                revents |= POLLHUP;
                            }
                        }
                    }
                    // Check send buffer for writability
                    if let Some(send_idx) = sock.send_buf_idx {
                        if let Some(Some(pipe)) = proc.pipes.get(send_idx) {
                            if pollfd.events & POLLOUT != 0 && pipe.free_space() > 0 {
                                revents |= POLLOUT;
                            }
                        }
                    }
                }
            }
        }

        pollfd.revents = revents;
        if revents != 0 {
            ready_count += 1;
        }
    }

    Ok(ready_count)
}
```

**Step 3: Run tests**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`
Expected: all tests pass

**Step 4: Commit**

```
git add crates/kernel/src/syscalls.rs
git commit -m "feat: implement sys_poll for I/O multiplexing across all fd types"
```

---

## Task 8: Wasm Exports — Socket & Poll Functions

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs`

Add kernel_* exports for all socket syscalls:

- `kernel_socket(domain: u32, sock_type: u32, protocol: u32) -> i32`
- `kernel_socketpair(domain: u32, sock_type: u32, protocol: u32, sv_ptr: *mut i32) -> i32`
  - Writes the two fds to sv_ptr[0] and sv_ptr[1]
- `kernel_bind(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32`
- `kernel_listen(fd: i32, backlog: u32) -> i32`
- `kernel_accept(fd: i32) -> i32`
- `kernel_connect(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32`
- `kernel_send(fd: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32`
- `kernel_recv(fd: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32`
- `kernel_shutdown(fd: i32, how: u32) -> i32`
- `kernel_getsockopt(fd: i32, level: u32, optname: u32, optval_ptr: *mut u32) -> i32`
  - Writes option value to optval_ptr
- `kernel_setsockopt(fd: i32, level: u32, optname: u32, optval: u32) -> i32`
- `kernel_poll(fds_ptr: *mut u8, nfds: u32, timeout: i32) -> i32`
  - fds_ptr points to array of WasmPollFd structs (8 bytes each)
  - Reads events, writes revents back
- `kernel_sendto(fd: i32, buf_ptr: *const u8, buf_len: u32, flags: u32, addr_ptr: *const u8, addr_len: u32) -> i32`
- `kernel_recvfrom(fd: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32, addr_ptr: *mut u8, addr_len: u32) -> i32`

Follow the same pattern as existing kernel_* exports: get global process, create WasmHostIO, call syscall handler, return result.

**Step 1: Add all exports**

**Step 2: Build for wasm32**

Run: `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release`
Expected: builds cleanly

**Step 3: Commit**

```
git add crates/kernel/src/wasm_api.rs
git commit -m "feat: add Wasm exports for socket and poll syscalls"
```

---

## Task 9: TypeScript Host — Socket Stubs + Poll Support

**Files:**
- Modify: `host/src/kernel.ts` — add socket host imports (no-op or error)
- Modify: `host/src/types.ts` — no socket methods needed on PlatformIO (sockets are kernel-internal for now)

Since Unix domain sockets are entirely kernel-internal and TCP is stubbed at the kernel level (ENOSYS), the TypeScript host doesn't need new PlatformIO methods yet. It just needs to:

1. Handle the new kernel exports when calling them from the JS side
2. No new host imports needed (socket state is kernel-managed)

**Step 1: Add socket-related kernel method wrappers**

Add methods to WasmPosixKernel class for calling the kernel_* exports:

```typescript
socket(domain: number, type: number, protocol: number): number {
    const fn = this.instance.exports.kernel_socket as Function;
    return fn(domain, type, protocol);
}

socketpair(domain: number, type: number, protocol: number): [number, number] {
    const fn = this.instance.exports.kernel_socketpair as Function;
    // Allocate 8 bytes for two i32 values
    const ptr = this.allocTemp(8);
    const result = fn(domain, type, protocol, ptr);
    if (result < 0) throw new Error(`socketpair failed: ${result}`);
    const view = new DataView(this.memory.buffer);
    const fd0 = view.getInt32(ptr, true);
    const fd1 = view.getInt32(ptr + 4, true);
    return [fd0, fd1];
}

poll(fds: Array<{fd: number, events: number}>, timeout: number): Array<{fd: number, events: number, revents: number}> {
    const fn = this.instance.exports.kernel_poll as Function;
    const nfds = fds.length;
    const ptr = this.allocTemp(nfds * 8); // 8 bytes per WasmPollFd
    const view = new DataView(this.memory.buffer);
    // Write pollfd structs
    for (let i = 0; i < nfds; i++) {
        view.setInt32(ptr + i * 8, fds[i].fd, true);
        view.setInt16(ptr + i * 8 + 4, fds[i].events, true);
        view.setInt16(ptr + i * 8 + 6, 0, true); // revents = 0
    }
    const result = fn(ptr, nfds, timeout);
    if (result < 0) throw new Error(`poll failed: ${result}`);
    // Read back revents
    return fds.map((f, i) => ({
        fd: f.fd,
        events: f.events,
        revents: view.getInt16(ptr + i * 8 + 6, true),
    }));
}

shutdown(fd: number, how: number): number {
    const fn = this.instance.exports.kernel_shutdown as Function;
    return fn(fd, how);
}

send(fd: number, data: Uint8Array, flags: number): number {
    const fn = this.instance.exports.kernel_send as Function;
    // Write data to Wasm memory, call, return
    // ... standard pattern
}

recv(fd: number, length: number, flags: number): Uint8Array {
    // ... standard pattern
}
```

**Step 2: Build TypeScript**

Run: `cd host && npx tsc --noEmit`
Expected: compiles cleanly

**Step 3: Commit**

```
git add host/src/kernel.ts host/src/types.ts
git commit -m "feat: add TypeScript socket and poll kernel method wrappers"
```

---

## Task 10: Update POSIX Status & Build Verification

**Files:**
- Modify: `docs/posix-status.md`

**Step 1: Update Socket Operations section**

```markdown
## Socket Operations

| Function | Status | Notes |
|----------|--------|-------|
| `socket()` | Partial | AF_UNIX (kernel-internal) and AF_INET (stub) supported. SOCK_STREAM only for AF_UNIX. SOCK_NONBLOCK and SOCK_CLOEXEC flags handled. |
| `socketpair()` | Full | AF_UNIX SOCK_STREAM. Bidirectional ring buffers (64KB each). Returns pre-connected pair. |
| `bind()` | Stub | Returns ENOSYS. Requires host network stack for AF_INET. |
| `listen()` | Stub | Returns ENOSYS. Requires host network stack. |
| `accept()` | Stub | Returns ENOSYS. Requires host network stack. |
| `connect()` | Stub | Returns ENOSYS. Requires host network stack. |
| `send()` / `recv()` | Partial | Works for connected Unix domain sockets (via socketpair). Delegates to read/write. MSG_PEEK not yet implemented. |
| `sendto()` / `recvfrom()` | Stub | Returns ENOSYS. Requires host network stack for UDP. |
| `setsockopt()` / `getsockopt()` | Partial | SOL_SOCKET level: SO_TYPE, SO_DOMAIN, SO_ERROR, SO_ACCEPTCONN readable. SO_REUSEADDR, SO_KEEPALIVE accepted (no-op). |
| `shutdown()` | Full | SHUT_RD, SHUT_WR, SHUT_RDWR. Properly closes buffer endpoints. |
| `select()` / `poll()` | Partial | poll() implemented. Checks readiness for regular files, pipes, and sockets. Timeout ignored (non-blocking only). select() can be userspace on top of poll(). |
```

**Step 2: Update Implementation Priority section**

Change Phase 6 line to:
```
6. **Phase 6 (Complete):** Sockets & I/O multiplexing — socket, socketpair, shutdown, send/recv, getsockopt/setsockopt, poll. TCP stubs (bind/listen/accept/connect return ENOSYS).
```

**Step 3: Run full test suite**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p wasm-posix-kernel`
Expected: all tests pass

**Step 4: Build Wasm**

Run: `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p wasm-posix-kernel --release`
Expected: builds cleanly

**Step 5: Commit**

```
git add docs/posix-status.md
git commit -m "docs: update POSIX status for Phase 6 sockets and poll"
```
