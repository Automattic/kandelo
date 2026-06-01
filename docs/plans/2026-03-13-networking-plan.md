# AF_INET Networking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add host-delegated AF_INET socket operations so PHP-WASM can make outbound HTTP requests.

**Architecture:** When the kernel sees connect/send/recv on AF_INET sockets, it delegates to new HostIO methods. Node.js backend uses real TCP via `net.Socket`. Browser backend parses HTTP from raw bytes and uses `fetch()`. DNS resolution is host-delegated via a new getaddrinfo syscall.

**Tech Stack:** Rust (kernel), C (glue), TypeScript (host)

---

## Task 1: Add ETIMEDOUT errno and Getaddrinfo syscall number

Add the missing errno value and new syscall enum variant to the shared types.

**Files:**
- Modify: `crates/shared/src/lib.rs`
- Modify: `libc/musl-overlay/arch/wasm32posix/bits/syscall.h.in`

**Changes to `crates/shared/src/lib.rs`:**

1. Add `ETIMEDOUT = 110` to the `Errno` enum (between ESHUTDOWN=108 and ECONNREFUSED=111):

```rust
    ESHUTDOWN = 108,
    ETIMEDOUT = 110,
    ECONNREFUSED = 111,
```

2. Add the `from_u32` match arm:

```rust
            108 => Some(Errno::ESHUTDOWN),
            110 => Some(Errno::ETIMEDOUT),
            111 => Some(Errno::ECONNREFUSED),
```

3. Add `Getaddrinfo = 140` to the `Syscall` enum (after `Wait4 = 139`):

```rust
    Wait4 = 139,
    Getaddrinfo = 140,
```

4. Add the `from_u32` match arm:

```rust
            139 => Some(Syscall::Wait4),
            140 => Some(Syscall::Getaddrinfo),
```

**Changes to `libc/musl-overlay/arch/wasm32posix/bits/syscall.h.in`:**

Add after the `__NR_fchdir` line (around line 296):

```c
#define __NR_getaddrinfo    140
```

**Verification:**

```bash
cargo test -p wasm-posix-shared --target aarch64-apple-darwin
```

**Commit:** `feat: add ETIMEDOUT errno and Getaddrinfo syscall number`

---

## Task 2: Add network HostIO trait methods

Add the five new host methods for network operations. All existing HostIO implementations (MockHostIO, TrackingHostIO, WasmHostIO) get stubs.

**Files:**
- Modify: `crates/kernel/src/process.rs`
- Modify: `crates/kernel/src/syscalls.rs` (MockHostIO and TrackingHostIO)
- Modify: `crates/kernel/src/wasm_api.rs` (WasmHostIO)

**Changes to `crates/kernel/src/process.rs`:**

Add to the `HostIO` trait after `host_waitpid`:

```rust
    /// Connect an AF_INET socket to a remote address.
    /// `handle` is the kernel-assigned socket handle.
    /// `addr` is the 4-byte IPv4 address.
    fn host_net_connect(&mut self, handle: i32, addr: &[u8], port: u16) -> Result<(), Errno>;

    /// Send data on a connected AF_INET socket.
    fn host_net_send(&mut self, handle: i32, data: &[u8], flags: u32) -> Result<usize, Errno>;

    /// Receive data from a connected AF_INET socket.
    /// Returns the bytes received (may be empty if connection closed).
    fn host_net_recv(&mut self, handle: i32, len: u32, flags: u32, buf: &mut [u8]) -> Result<usize, Errno>;

    /// Close a host-side network socket.
    fn host_net_close(&mut self, handle: i32) -> Result<(), Errno>;

    /// Resolve a hostname to an IPv4 address (4 bytes).
    fn host_getaddrinfo(&mut self, name: &[u8], result: &mut [u8]) -> Result<usize, Errno>;
```

**Changes to `crates/kernel/src/syscalls.rs`:**

In both `MockHostIO` and `TrackingHostIO` (the test mock structs), add stub implementations:

```rust
        fn host_net_connect(&mut self, _handle: i32, _addr: &[u8], _port: u16) -> Result<(), Errno> {
            Err(Errno::ECONNREFUSED)
        }
        fn host_net_send(&mut self, _handle: i32, _data: &[u8], _flags: u32) -> Result<usize, Errno> {
            Err(Errno::ENOTCONN)
        }
        fn host_net_recv(&mut self, _handle: i32, _len: u32, _flags: u32, _buf: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOTCONN)
        }
        fn host_net_close(&mut self, _handle: i32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_getaddrinfo(&mut self, _name: &[u8], _result: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOENT)
        }
```

**Changes to `crates/kernel/src/wasm_api.rs`:**

1. Add host imports in the `extern "C"` block:

```rust
    fn host_net_connect(handle: i32, addr_ptr: *const u8, addr_len: u32, port: u32) -> i32;
    fn host_net_send(handle: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_recv(handle: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_close(handle: i32) -> i32;
    fn host_getaddrinfo(name_ptr: *const u8, name_len: u32, result_ptr: *mut u8, result_len: u32) -> i32;
```

2. Add `HostIO` trait implementations in `impl HostIO for WasmHostIO`:

```rust
    fn host_net_connect(&mut self, handle: i32, addr: &[u8], port: u16) -> Result<(), Errno> {
        let result = unsafe { host_net_connect(handle, addr.as_ptr(), addr.len() as u32, port as u32) };
        i32_to_result(result)
    }

    fn host_net_send(&mut self, handle: i32, data: &[u8], flags: u32) -> Result<usize, Errno> {
        let result = unsafe { host_net_send(handle, data.as_ptr(), data.len() as u32, flags) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_net_recv(&mut self, handle: i32, _len: u32, flags: u32, buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_net_recv(handle, buf.as_mut_ptr(), buf.len() as u32, flags) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_net_close(&mut self, handle: i32) -> Result<(), Errno> {
        let result = unsafe { host_net_close(handle) };
        i32_to_result(result)
    }

    fn host_getaddrinfo(&mut self, name: &[u8], result_buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_getaddrinfo(name.as_ptr(), name.len() as u32, result_buf.as_mut_ptr(), result_buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }
```

**Verification:**

```bash
cargo test -p kandelo --target aarch64-apple-darwin
```

All existing tests should pass (stubs return reasonable errors).

**Commit:** `feat: add network HostIO trait methods for AF_INET delegation`

---

## Task 3: Implement AF_INET connect/send/recv/close in kernel syscalls

Modify the existing socket syscall handlers to detect AF_INET sockets and delegate to host network methods.

**Files:**
- Modify: `crates/kernel/src/socket.rs` — Add `host_handle` field to SocketInfo
- Modify: `crates/kernel/src/syscalls.rs` — AF_INET branches in sys_connect, sys_send, sys_recv; cleanup on close; new sys_getaddrinfo

**Changes to `crates/kernel/src/socket.rs`:**

Add a `host_net_handle` field to `SocketInfo`:

```rust
pub struct SocketInfo {
    pub domain: SocketDomain,
    pub sock_type: SocketType,
    pub protocol: u32,
    pub state: SocketState,
    pub peer_idx: Option<usize>,
    pub recv_buf_idx: Option<usize>,
    pub send_buf_idx: Option<usize>,
    pub shut_rd: bool,
    pub shut_wr: bool,
    /// Host-side network handle for AF_INET sockets (assigned on connect).
    pub host_net_handle: Option<i32>,
}
```

Initialize it as `None` in `SocketInfo::new()`:

```rust
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
            host_net_handle: None,
        }
    }
```

**Changes to `crates/kernel/src/syscalls.rs`:**

1. **Modify `sys_connect`** — replace the current stub with AF_INET support:

```rust
/// Connect a socket to an address.
/// AF_UNIX: returns ECONNREFUSED (no Unix domain connect support).
/// AF_INET: delegates to host via host_net_connect.
pub fn sys_connect(proc: &mut Process, host: &mut dyn HostIO, fd: i32, addr: &[u8]) -> Result<(), Errno> {
    use crate::socket::{SocketDomain, SocketState};

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;

    match sock.domain {
        SocketDomain::Inet | SocketDomain::Inet6 => {
            if sock.state == SocketState::Connected {
                return Err(Errno::EISCONN);
            }
            // Parse sockaddr_in: family(2) + port(2) + addr(4)
            if addr.len() < 8 {
                return Err(Errno::EINVAL);
            }
            let port = u16::from_be_bytes([addr[2], addr[3]]);
            let ip = &addr[4..8];
            let net_handle = sock_idx as i32;
            host.host_net_connect(net_handle, ip, port)?;
            let sock = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
            sock.state = SocketState::Connected;
            sock.host_net_handle = Some(net_handle);
            Ok(())
        }
        SocketDomain::Unix => Err(Errno::ECONNREFUSED),
    }
}
```

2. **Modify `sys_send`** — add AF_INET branch before the existing AF_UNIX delegation to sys_write:

```rust
pub fn sys_send(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &[u8],
    flags: u32,
) -> Result<usize, Errno> {
    use crate::socket::{SocketDomain, SocketState};
    use wasm_posix_shared::socket::MSG_NOSIGNAL;

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

    // AF_INET: delegate to host
    if sock.domain == SocketDomain::Inet || sock.domain == SocketDomain::Inet6 {
        let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
        return host.host_net_send(net_handle, buf, flags);
    }

    // AF_UNIX: existing pipe-backed path
    let nosignal = flags & MSG_NOSIGNAL != 0;
    let sigpipe_was_pending = proc.signals.is_pending(wasm_posix_shared::signal::SIGPIPE);
    let result = sys_write(proc, host, fd, buf);
    if nosignal && !sigpipe_was_pending {
        proc.signals.clear(wasm_posix_shared::signal::SIGPIPE);
    }
    result
}
```

3. **Modify `sys_recv`** — add AF_INET branch:

```rust
pub fn sys_recv(
    proc: &mut Process,
    host: &mut dyn HostIO,
    fd: i32,
    buf: &mut [u8],
    flags: u32,
) -> Result<usize, Errno> {
    use crate::socket::{SocketDomain, SocketState};
    use wasm_posix_shared::socket::{MSG_DONTWAIT, MSG_PEEK};
    const MSG_WAITALL: u32 = 0x100;

    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Socket {
        return Err(Errno::ENOTSOCK);
    }
    let status_flags = ofd.status_flags;
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    if sock.state != SocketState::Connected {
        return Err(Errno::ENOTCONN);
    }

    // AF_INET: delegate to host
    if sock.domain == SocketDomain::Inet || sock.domain == SocketDomain::Inet6 {
        if sock.shut_rd {
            return Ok(0);
        }
        let net_handle = sock.host_net_handle.ok_or(Errno::ENOTCONN)?;
        return host.host_net_recv(net_handle, buf.len() as u32, flags, buf);
    }

    // AF_UNIX: existing pipe-backed path (rest of existing code unchanged)
    if sock.shut_rd {
        return Ok(0);
    }
    let recv_buf_idx = sock.recv_buf_idx.ok_or(Errno::ENOTCONN)?;
    let peek = flags & MSG_PEEK != 0;
    let nonblock = (status_flags & O_NONBLOCK != 0) || (flags & MSG_DONTWAIT != 0);
    let waitall = flags & MSG_WAITALL != 0 && !peek;
    let mut total = 0usize;

    loop {
        let pipe = proc
            .pipes
            .get_mut(recv_buf_idx)
            .and_then(|p| p.as_mut())
            .ok_or(Errno::EBADF)?;
        let n = if peek { pipe.peek(&mut buf[total..]) } else { pipe.read(&mut buf[total..]) };
        total += n;
        if total >= buf.len() || (total > 0 && !waitall) {
            return Ok(total);
        }
        if n == 0 && !pipe.is_write_end_open() {
            return Ok(total);
        }
        if nonblock {
            return Err(Errno::EAGAIN);
        }
        if proc.signals.deliverable() != 0 {
            return Err(Errno::EINTR);
        }
        let _ = host.host_nanosleep(0, 1_000_000);
    }
}
```

4. **Modify `sys_shutdown`** — add AF_INET host close on SHUT_RDWR:

In the `SHUT_RDWR` arm of `sys_shutdown`, after setting `shut_rd` and `shut_wr`, add:

```rust
        SHUT_RDWR => {
            sock.shut_rd = true;
            sock.shut_wr = true;
            // Close host network connection if AF_INET
            if let Some(net_handle) = sock.host_net_handle {
                let _ = host.host_net_close(net_handle);
            }
            // existing pipe cleanup...
```

Note: `sys_shutdown` needs `host: &mut dyn HostIO` parameter added.

5. **Modify `sys_close`** — add AF_INET cleanup in the Socket close path:

In `sys_close`, in the `FileType::Socket` match arm where sockets are freed, add host_net_close:

```rust
            FileType::Socket => {
                let sock_idx = (-(host_handle + 1)) as usize;
                // Close host network connection if AF_INET
                if let Some(sock) = proc.sockets.get(sock_idx) {
                    if let Some(net_handle) = sock.host_net_handle {
                        let _ = host.host_net_close(net_handle);
                    }
                }
                proc.sockets.free(sock_idx);
            }
```

6. **Add `sys_getaddrinfo`:**

```rust
/// Resolve a hostname to an IPv4 address via host delegation.
/// Returns 4 (bytes written) on success.
pub fn sys_getaddrinfo(
    _proc: &mut Process,
    host: &mut dyn HostIO,
    name: &[u8],
    result_buf: &mut [u8],
) -> Result<usize, Errno> {
    if result_buf.len() < 4 {
        return Err(Errno::EINVAL);
    }
    host.host_getaddrinfo(name, result_buf)
}
```

7. **Add `kernel_getaddrinfo` export** in `wasm_api.rs`:

```rust
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getaddrinfo(name_ptr: *const u8, name_len: u32, result_ptr: *mut u8) -> i32 {
    let proc = unsafe { get_process() };
    let mut host = WasmHostIO;
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let result_buf = unsafe { slice::from_raw_parts_mut(result_ptr, 16) }; // sockaddr_in sized
    match syscalls::sys_getaddrinfo(proc, &mut host, name, result_buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}
```

**Verification:**

```bash
cargo test -p kandelo --target aarch64-apple-darwin
```

**Commit:** `feat: implement AF_INET connect/send/recv with host delegation`

---

## Task 4: Add glue layer dispatch for getaddrinfo

Wire up the C glue layer to dispatch the new getaddrinfo syscall.

**Files:**
- Modify: `libc/glue/syscall_glue.c`
- Modify: `libc/glue/syscall_imports.h`

**Changes to `libc/glue/syscall_imports.h`:**

Add in the Socket operations section:

```c
KERNEL_IMPORT(kernel_getaddrinfo)
int32_t kernel_getaddrinfo(const uint8_t *name_ptr, uint32_t name_len,
                           uint8_t *result_ptr);
```

**Changes to `libc/glue/syscall_glue.c`:**

Add the define:

```c
#define SYS_GETADDRINFO 140
```

Add a case in `__do_syscall` (near the other socket cases):

```c
    case SYS_GETADDRINFO: {
        const char *name = (const char *)a1;
        unsigned name_len = __builtin_strlen(name);
        return kernel_getaddrinfo((const uint8_t *)name, name_len, (uint8_t *)a2);
    }
```

**Verification:**

```bash
bash build.sh
```

**Commit:** `feat: add glue dispatch for getaddrinfo syscall`

---

## Task 5: Add host-side network imports in kernel.ts

Add the five new host import functions in the TypeScript host layer. Start with stubs that return ECONNREFUSED — the actual backends come in later tasks.

**Files:**
- Modify: `host/src/kernel.ts`
- Modify: `host/src/types.ts`

**Changes to `host/src/types.ts`:**

Add a `NetworkIO` interface and add it as an optional member of `PlatformIO`:

```typescript
export interface NetworkIO {
  connect(handle: number, addr: Uint8Array, port: number): void;
  send(handle: number, data: Uint8Array, flags: number): number;
  recv(handle: number, maxLen: number, flags: number): Uint8Array;
  close(handle: number): void;
  getaddrinfo(hostname: string): Uint8Array; // Returns 4-byte IPv4
}
```

Add to `PlatformIO`:

```typescript
  // Networking (optional — only needed for AF_INET support)
  network?: NetworkIO;
```

**Changes to `host/src/kernel.ts`:**

1. Add host imports in the `importObject.env`:

```typescript
        host_net_connect: (handle: number, addrPtr: number, addrLen: number, port: number): number => {
          return this.hostNetConnect(handle, addrPtr, addrLen, port);
        },
        host_net_send: (handle: number, bufPtr: number, bufLen: number, flags: number): number => {
          return this.hostNetSend(handle, bufPtr, bufLen, flags);
        },
        host_net_recv: (handle: number, bufPtr: number, bufLen: number, flags: number): number => {
          return this.hostNetRecv(handle, bufPtr, bufLen, flags);
        },
        host_net_close: (handle: number): number => {
          return this.hostNetClose(handle);
        },
        host_getaddrinfo: (namePtr: number, nameLen: number, resultPtr: number, resultLen: number): number => {
          return this.hostGetaddrinfo(namePtr, nameLen, resultPtr, resultLen);
        },
```

2. Add private methods:

```typescript
  private hostNetConnect(handle: number, addrPtr: number, addrLen: number, port: number): number {
    if (!this.io.network) return -111; // -ECONNREFUSED
    try {
      const mem = new Uint8Array(this.memory!.buffer);
      const addr = mem.slice(addrPtr, addrPtr + addrLen);
      this.io.network.connect(handle, addr, port);
      return 0;
    } catch {
      return -111; // -ECONNREFUSED
    }
  }

  private hostNetSend(handle: number, bufPtr: number, bufLen: number, flags: number): number {
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      const mem = new Uint8Array(this.memory!.buffer);
      const data = mem.slice(bufPtr, bufPtr + bufLen);
      return this.io.network.send(handle, data, flags);
    } catch {
      return -32; // -EPIPE
    }
  }

  private hostNetRecv(handle: number, bufPtr: number, bufLen: number, flags: number): number {
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      const data = this.io.network.recv(handle, bufLen, flags);
      if (data.length > 0 && this.memory) {
        const mem = new Uint8Array(this.memory.buffer);
        mem.set(data, bufPtr);
      }
      return data.length;
    } catch {
      return -104; // -ECONNRESET
    }
  }

  private hostNetClose(handle: number): number {
    if (!this.io.network) return 0;
    try {
      this.io.network.close(handle);
      return 0;
    } catch {
      return 0;
    }
  }

  private hostGetaddrinfo(namePtr: number, nameLen: number, resultPtr: number, resultLen: number): number {
    if (!this.io.network) return -2; // -ENOENT
    try {
      const mem = new Uint8Array(this.memory!.buffer);
      const name = new TextDecoder().decode(mem.slice(namePtr, namePtr + nameLen));
      const addr = this.io.network.getaddrinfo(name);
      if (addr.length > resultLen) return -22; // -EINVAL
      mem.set(addr, resultPtr);
      return addr.length;
    } catch {
      return -2; // -ENOENT
    }
  }
```

**Verification:**

```bash
bash build.sh && cd host && npx vitest run
```

**Commit:** `feat: add host-side network import stubs in kernel.ts`

---

## Task 6: Implement Node.js TCP network backend

Create a real TCP backend using Node.js `net.Socket` for use in Node.js environments.

**Files:**
- Create: `host/src/networking/tcp-backend.ts`

**Implementation:**

```typescript
import * as net from "net";
import type { NetworkIO } from "../types";
import { lookup } from "dns";

interface Connection {
  socket: net.Socket;
  recvBuf: Buffer;
  connected: boolean;
  error: Error | null;
  closed: boolean;
}

export class TcpNetworkBackend implements NetworkIO {
  private connections = new Map<number, Connection>();

  connect(handle: number, addr: Uint8Array, port: number): void {
    const ip = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
    const socket = new net.Socket();
    const conn: Connection = {
      socket,
      recvBuf: Buffer.alloc(0),
      connected: false,
      error: null,
      closed: false,
    };

    socket.on("data", (data: Buffer) => {
      conn.recvBuf = Buffer.concat([conn.recvBuf, data]);
    });

    socket.on("error", (err: Error) => {
      conn.error = err;
    });

    socket.on("close", () => {
      conn.closed = true;
    });

    // Synchronous connect using Atomics — block until connected or error
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);

    socket.connect(port, ip, () => {
      conn.connected = true;
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });

    socket.on("error", () => {
      Atomics.store(flag, 0, -1);
      Atomics.notify(flag, 0);
    });

    Atomics.wait(flag, 0, 0, 30000); // 30s timeout

    if (flag[0] !== 1) {
      socket.destroy();
      const errMsg = conn.error?.message ?? "";
      if (errMsg.includes("ECONNREFUSED")) {
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      }
      if (errMsg.includes("ETIMEDOUT") || flag[0] === 0) {
        throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
      }
      throw conn.error ?? new Error("Connection failed");
    }

    this.connections.set(handle, conn);
  }

  send(handle: number, data: Uint8Array, _flags: number): number {
    const conn = this.connections.get(handle);
    if (!conn || !conn.connected) throw new Error("ENOTCONN");
    conn.socket.write(data);
    return data.length;
  }

  recv(handle: number, maxLen: number, _flags: number): Uint8Array {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    // Poll for data with Atomics.wait
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);

    if (conn.recvBuf.length === 0 && !conn.closed) {
      const onData = () => {
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
      };
      const onClose = () => {
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
      };
      conn.socket.once("data", onData);
      conn.socket.once("close", onClose);

      if (conn.recvBuf.length === 0 && !conn.closed) {
        Atomics.wait(flag, 0, 0, 30000);
      }

      conn.socket.removeListener("data", onData);
      conn.socket.removeListener("close", onClose);
    }

    const len = Math.min(maxLen, conn.recvBuf.length);
    if (len === 0) return new Uint8Array(0);

    const result = new Uint8Array(conn.recvBuf.buffer, conn.recvBuf.byteOffset, len);
    conn.recvBuf = conn.recvBuf.subarray(len);
    return result;
  }

  close(handle: number): void {
    const conn = this.connections.get(handle);
    if (conn) {
      conn.socket.destroy();
      this.connections.delete(handle);
    }
  }

  getaddrinfo(hostname: string): Uint8Array {
    // Synchronous DNS lookup
    const sab = new SharedArrayBuffer(8);
    const flag = new Int32Array(sab);
    const result = new Uint8Array(4);

    lookup(hostname, 4, (err, address) => {
      if (err || !address) {
        Atomics.store(flag, 0, -1);
      } else {
        const parts = address.split(".").map(Number);
        result[0] = parts[0];
        result[1] = parts[1];
        result[2] = parts[2];
        result[3] = parts[3];
        Atomics.store(flag, 0, 1);
      }
      Atomics.notify(flag, 0);
    });

    Atomics.wait(flag, 0, 0, 10000); // 10s timeout
    if (flag[0] !== 1) throw new Error("DNS resolution failed");
    return result;
  }
}
```

**NOTE:** The Atomics.wait approach above works when the kernel runs in a Worker thread. If running on the main thread (Node.js), the event loop blocks are problematic. A production implementation would use `worker_threads` to avoid this, but this initial implementation works for the common Worker-based architecture.

**Verification:**

```bash
cd host && npx tsc --noEmit && npx vitest run
```

**Commit:** `feat: add Node.js TCP network backend`

---

## Task 7: Implement browser fetch network backend

Create a fetch-based backend for browser environments. Parses raw HTTP request bytes from send(), calls fetch(), returns response as raw HTTP bytes via recv().

**Files:**
- Create: `host/src/networking/fetch-backend.ts`

**Implementation:**

```typescript
import type { NetworkIO } from "../types";

interface ConnectionState {
  ip: Uint8Array;
  port: number;
  sendBuf: Uint8Array;
  responseBuf: Uint8Array | null;
  responseOffset: number;
  fetchDone: boolean;
  fetchError: Error | null;
}

export interface FetchBackendOptions {
  corsProxyUrl?: string;
}

export class FetchNetworkBackend implements NetworkIO {
  private connections = new Map<number, ConnectionState>();
  private options: FetchBackendOptions;

  constructor(options?: FetchBackendOptions) {
    this.options = options ?? {};
  }

  connect(handle: number, addr: Uint8Array, port: number): void {
    // HTTPS not supported in browser fetch backend
    if (port === 443) {
      throw Object.assign(new Error("HTTPS not supported in browser fetch backend"), { code: "ECONNREFUSED" });
    }
    this.connections.set(handle, {
      ip: new Uint8Array(addr),
      port,
      sendBuf: new Uint8Array(0),
      responseBuf: null,
      responseOffset: 0,
      fetchDone: false,
      fetchError: null,
    });
  }

  send(handle: number, data: Uint8Array, _flags: number): number {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    // Append to send buffer
    const newBuf = new Uint8Array(conn.sendBuf.length + data.length);
    newBuf.set(conn.sendBuf);
    newBuf.set(data, conn.sendBuf.length);
    conn.sendBuf = newBuf;

    // Check if we have a complete HTTP request (headers end with \r\n\r\n)
    const headerEnd = findHeaderEnd(conn.sendBuf);
    if (headerEnd === -1) {
      return data.length; // Still buffering
    }

    // Parse headers to check Content-Length
    const headerStr = new TextDecoder().decode(conn.sendBuf.subarray(0, headerEnd));
    const contentLength = parseContentLength(headerStr);
    const bodyStart = headerEnd + 4; // skip \r\n\r\n
    const bodyReceived = conn.sendBuf.length - bodyStart;

    if (contentLength > 0 && bodyReceived < contentLength) {
      return data.length; // Still waiting for body
    }

    // We have a complete request — parse and issue fetch
    const { method, path, headers, body } = parseHttpRequest(conn.sendBuf, headerEnd);
    const host = headers.get("host") || `${conn.ip[0]}.${conn.ip[1]}.${conn.ip[2]}.${conn.ip[3]}`;
    const url = `http://${host}${path}`;

    // Convert headers map to Headers object (skip Host and Connection)
    const fetchHeaders = new Headers();
    for (const [key, value] of headers) {
      const lower = key.toLowerCase();
      if (lower !== "host" && lower !== "connection") {
        fetchHeaders.set(key, value);
      }
    }

    // Issue fetch synchronously via Atomics.wait
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);

    const doFetch = async () => {
      try {
        let response: Response;
        try {
          response = await fetch(url, {
            method,
            headers: fetchHeaders,
            body: body && body.length > 0 ? body : undefined,
          });
        } catch (e) {
          // Try CORS proxy if configured
          if (this.options.corsProxyUrl) {
            response = await fetch(`${this.options.corsProxyUrl}${url}`, {
              method,
              headers: fetchHeaders,
              body: body && body.length > 0 ? body : undefined,
            });
          } else {
            throw e;
          }
        }

        conn.responseBuf = formatHttpResponse(response.status, response.statusText, response.headers, await response.arrayBuffer());
        conn.fetchDone = true;
      } catch (e) {
        conn.fetchError = e as Error;
        conn.fetchDone = true;
      }
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    };

    doFetch();
    Atomics.wait(flag, 0, 0, 30000);

    if (conn.fetchError) {
      throw conn.fetchError;
    }

    return data.length;
  }

  recv(handle: number, maxLen: number, _flags: number): Uint8Array {
    const conn = this.connections.get(handle);
    if (!conn) throw new Error("ENOTCONN");

    if (!conn.responseBuf) {
      if (conn.fetchError) throw conn.fetchError;
      return new Uint8Array(0); // No data yet
    }

    const remaining = conn.responseBuf.length - conn.responseOffset;
    const len = Math.min(maxLen, remaining);
    if (len === 0) return new Uint8Array(0);

    const result = conn.responseBuf.slice(conn.responseOffset, conn.responseOffset + len);
    conn.responseOffset += len;
    return result;
  }

  close(handle: number): void {
    this.connections.delete(handle);
  }

  getaddrinfo(hostname: string): Uint8Array {
    // In the browser, return a synthetic IP.
    // The actual connection uses the Host header, not this IP.
    // Use a deterministic hash to generate a fake IP in the 10.x.x.x range.
    let hash = 0;
    for (let i = 0; i < hostname.length; i++) {
      hash = ((hash << 5) - hash + hostname.charCodeAt(i)) | 0;
    }
    return new Uint8Array([10, (hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff]);
  }
}

/** Find the position of \r\n\r\n in the buffer. Returns -1 if not found. */
function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}

/** Extract Content-Length from raw header string. Returns 0 if not present. */
function parseContentLength(headers: string): number {
  const match = headers.match(/content-length:\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

/** Parse a raw HTTP request into method, path, headers, body. */
function parseHttpRequest(buf: Uint8Array, headerEnd: number): {
  method: string;
  path: string;
  headers: Map<string, string>;
  body: Uint8Array | null;
} {
  const headerStr = new TextDecoder().decode(buf.subarray(0, headerEnd));
  const lines = headerStr.split("\r\n");
  const [method, path] = lines[0].split(" ");
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon > 0) {
      headers.set(lines[i].substring(0, colon).trim(), lines[i].substring(colon + 1).trim());
    }
  }
  const bodyStart = headerEnd + 4;
  const body = bodyStart < buf.length ? buf.subarray(bodyStart) : null;
  return { method, path, headers, body };
}

/** Format an HTTP response as raw bytes. */
function formatHttpResponse(
  status: number,
  statusText: string,
  headers: Headers,
  body: ArrayBuffer,
): Uint8Array {
  const bodyBytes = new Uint8Array(body);
  let headerStr = `HTTP/1.1 ${status} ${statusText}\r\n`;
  headers.forEach((value, key) => {
    headerStr += `${key}: ${value}\r\n`;
  });
  // Ensure Content-Length is set
  if (!headers.has("content-length")) {
    headerStr += `Content-Length: ${bodyBytes.length}\r\n`;
  }
  headerStr += "\r\n";

  const headerBytes = new TextEncoder().encode(headerStr);
  const result = new Uint8Array(headerBytes.length + bodyBytes.length);
  result.set(headerBytes);
  result.set(bodyBytes, headerBytes.length);
  return result;
}
```

**Verification:**

```bash
cd host && npx tsc --noEmit
```

**Commit:** `feat: add browser fetch network backend`

---

## Task 8: Export networking backends from host package

Wire up the networking backends in the host package exports.

**Files:**
- Create: `host/src/networking/index.ts`
- Modify: `host/src/index.ts`

**Create `host/src/networking/index.ts`:**

```typescript
export { TcpNetworkBackend } from "./tcp-backend";
export { FetchNetworkBackend } from "./fetch-backend";
export type { FetchBackendOptions } from "./fetch-backend";
```

**Modify `host/src/index.ts`:**

Add the networking exports:

```typescript
export { TcpNetworkBackend, FetchNetworkBackend } from "./networking";
export type { NetworkIO } from "./types";
```

**Verification:**

```bash
bash build.sh && cd host && npx vitest run
```

**Commit:** `feat: export networking backends from host package`

---

## Task 9: Add unit tests for fetch backend HTTP parsing

Test the HTTP request parsing and response formatting logic in the fetch backend.

**Files:**
- Create: `host/src/networking/__tests__/fetch-backend.test.ts`

**Tests to write:**

```typescript
import { describe, it, expect } from "vitest";
import { FetchNetworkBackend } from "../fetch-backend";

describe("FetchNetworkBackend", () => {
  describe("getaddrinfo", () => {
    it("returns a 4-byte address for any hostname", () => {
      const backend = new FetchNetworkBackend();
      const addr = backend.getaddrinfo("example.com");
      expect(addr.length).toBe(4);
      expect(addr[0]).toBe(10); // 10.x.x.x range
    });

    it("returns deterministic results for same hostname", () => {
      const backend = new FetchNetworkBackend();
      const addr1 = backend.getaddrinfo("example.com");
      const addr2 = backend.getaddrinfo("example.com");
      expect(addr1).toEqual(addr2);
    });
  });

  describe("connect", () => {
    it("succeeds for port 80", () => {
      const backend = new FetchNetworkBackend();
      expect(() => {
        backend.connect(1, new Uint8Array([93, 184, 216, 34]), 80);
      }).not.toThrow();
    });

    it("throws for port 443 (HTTPS not supported)", () => {
      const backend = new FetchNetworkBackend();
      expect(() => {
        backend.connect(1, new Uint8Array([93, 184, 216, 34]), 443);
      }).toThrow(/HTTPS/);
    });
  });

  describe("close", () => {
    it("cleans up connection state", () => {
      const backend = new FetchNetworkBackend();
      backend.connect(1, new Uint8Array([93, 184, 216, 34]), 80);
      backend.close(1);
      expect(() => backend.recv(1, 100, 0)).toThrow();
    });
  });

  describe("recv without send", () => {
    it("returns empty buffer when no fetch has completed", () => {
      const backend = new FetchNetworkBackend();
      backend.connect(1, new Uint8Array([93, 184, 216, 34]), 80);
      const data = backend.recv(1, 100, 0);
      expect(data.length).toBe(0);
    });
  });
});
```

**Verification:**

```bash
cd host && npx vitest run src/networking/__tests__/fetch-backend.test.ts
```

**Commit:** `test: add unit tests for fetch network backend`

---

## Task 10: Add kernel-side unit tests for AF_INET socket operations

Add cargo tests verifying the AF_INET connect/send/recv delegation and getaddrinfo.

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` (in the `#[cfg(test)]` module)

**Tests to add:**

```rust
    #[test]
    fn test_inet_socket_creation() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        assert!(fd >= 0);
        // Verify it's an inet socket via getsockopt
        let domain = sys_getsockopt(&mut proc, fd, SOL_SOCKET, SO_DOMAIN).unwrap();
        assert_eq!(domain, AF_INET);
    }

    #[test]
    fn test_inet_connect_returns_econnrefused_with_mock() {
        // MockHostIO returns ECONNREFUSED for host_net_connect
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        // sockaddr_in: AF_INET(2) + port(80) + IP(127.0.0.1)
        let addr = [2, 0, 0, 80, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
        let err = sys_connect(&mut proc, &mut host, fd, &addr).unwrap_err();
        assert_eq!(err, Errno::ECONNREFUSED);
    }

    #[test]
    fn test_inet_send_on_unconnected_returns_enotconn() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_socket(&mut proc, &mut host, AF_INET, SOCK_STREAM, 0).unwrap();
        let err = sys_send(&mut proc, &mut host, fd, b"hello", 0).unwrap_err();
        assert_eq!(err, Errno::ENOTCONN);
    }

    #[test]
    fn test_unix_socket_connect_still_returns_econnrefused() {
        // Regression: AF_UNIX connect should still fail
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let fd = sys_socket(&mut proc, &mut host, AF_UNIX, SOCK_STREAM, 0).unwrap();
        let addr = [1, 0]; // AF_UNIX family
        let err = sys_connect(&mut proc, &mut host, fd, &addr).unwrap_err();
        assert_eq!(err, Errno::ECONNREFUSED);
    }

    #[test]
    fn test_getaddrinfo_returns_enoent_with_mock() {
        let mut proc = Process::new(1);
        let mut host = MockHostIO::new();
        let mut result = [0u8; 16];
        let err = sys_getaddrinfo(&mut proc, &mut host, b"example.com", &mut result).unwrap_err();
        assert_eq!(err, Errno::ENOENT);
    }
```

**Verification:**

```bash
cargo test -p kandelo --target aarch64-apple-darwin
```

**Commit:** `test: add kernel-side unit tests for AF_INET socket operations`

---

## Verification

After all tasks are complete:

1. `cargo test -p kandelo --target aarch64-apple-darwin` — all tests pass
2. `bash build.sh` — wasm build succeeds
3. `cd host && npx vitest run` — host tests pass
