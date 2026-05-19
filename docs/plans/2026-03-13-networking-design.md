# AF_INET Networking Design

**Goal:** Add outbound HTTP networking for PHP-WASM by delegating AF_INET socket operations to the host.

**Architecture:** Socket-level delegation — the kernel delegates connect/send/recv for AF_INET sockets to the host via new HostIO methods. Two host backends: Node.js (raw TCP via `net.Socket`) and browser (HTTP via `fetch()`). DNS resolution is host-delegated via a new getaddrinfo syscall.

**Scope:** HTTP in browser, HTTP/HTTPS in Node.js. Browser HTTPS deferred (TLS MITM approach can be layered on later).

---

## 1. Architecture Overview

Three layers of change:

1. **Kernel** — New HostIO trait methods: `host_connect`, `host_send`, `host_recv`, `host_close_socket`, `host_getaddrinfo`. Existing `sys_connect`/`sys_send`/`sys_recv` gain AF_INET branches that delegate to these methods.

2. **Host — Node.js backend** — Real TCP via `net.Socket`. `host_connect` opens a TCP connection, `host_send`/`host_recv` pass raw bytes through. PHP's OpenSSL handles TLS end-to-end for HTTPS.

3. **Host — Browser backend** — HTTP via `fetch()`. `host_connect` records the destination. `host_send` buffers bytes until a complete HTTP request is detected, then calls `fetch()`. `host_recv` returns the response formatted as raw HTTP bytes. HTTPS deferred.

**DNS:** A new `host_getaddrinfo` import lets the kernel delegate name resolution to the host. Node.js uses `dns.lookup()`. In the browser, the host resolves via DNS-over-HTTPS or returns a real IP (fetch handles its own DNS internally anyway, but PHP needs a valid sockaddr_in for connect()).

AF_UNIX sockets continue using the existing kernel-internal pipe-backed path — no changes.

## 2. Kernel-Side Changes

### New HostIO trait methods

In `crates/kernel/src/process.rs`:

```rust
fn host_connect(&mut self, handle: i32, addr: &[u8], port: u16) -> Result<(), Errno>;
fn host_send(&mut self, handle: i32, data: &[u8], flags: u32) -> Result<usize, Errno>;
fn host_recv(&mut self, handle: i32, len: usize, flags: u32) -> Result<Vec<u8>, Errno>;
fn host_close_socket(&mut self, handle: i32) -> Result<(), Errno>;
fn host_getaddrinfo(&mut self, hostname: &[u8]) -> Result<Vec<u8>, Errno>;
```

The `handle` is a kernel-assigned identifier for the host-side connection (separate from the fd — one per AF_INET socket).

### Modified syscall handlers

In `crates/kernel/src/syscalls.rs`:

- **`sys_connect`** — Currently returns ECONNREFUSED. New behavior: if socket domain is AF_INET, parse `sockaddr_in` from the address buffer (extract IP + port), call `host.host_connect(handle, addr, port)`, set socket state to Connected.

- **`sys_send`** — Currently only works for AF_UNIX (delegates to `sys_write` on pipe buffer). New behavior: if socket is AF_INET and Connected, call `host.host_send(handle, data, flags)` instead of writing to a pipe.

- **`sys_recv`** — Same pattern. AF_INET sockets call `host.host_recv(handle, len, flags)` instead of reading from a pipe.

- **`sys_shutdown` / close** — AF_INET sockets call `host.host_close_socket(handle)` to clean up host-side resources.

### New getaddrinfo syscall

New syscall number `Getaddrinfo = 140`. The kernel export `kernel_getaddrinfo(name_ptr, name_len, result_ptr)`:
1. Reads hostname string from Wasm memory
2. Calls `host.host_getaddrinfo(hostname)`
3. Host returns 4 bytes (IPv4 address)
4. Kernel writes a packed `sockaddr_in` to `result_ptr`
5. Returns 0 on success, negative errno on failure

### musl integration

musl's `getaddrinfo()` needs to call our syscall instead of doing its own DNS via UDP sockets. Patch musl's `__lookup_name()` in the overlay to use `__syscall(SYS_getaddrinfo, ...)`.

## 3. Host-Side — Node.js TCP Backend

Real TCP via `net.Socket`. Simplest backend.

**Connection lifecycle:**

```
host_connect(handle, "93.184.216.34", 80)
  → new net.Socket() → socket.connect(80, "93.184.216.34")
  → store in Map<handle, Socket>

host_send(handle, bytes, flags)
  → socket.write(bytes) → return bytes written

host_recv(handle, len, flags)
  → read from socket's internal buffer (data accumulated via 'data' event)
  → if no data available: block via Atomics.wait until data arrives or socket closes

host_close_socket(handle)
  → socket.destroy() → remove from map
```

**Blocking recv():** The kernel runs in a Worker. When `host_recv` has no data, the Worker blocks via `Atomics.wait()`. The main thread's socket `'data'` event handler writes incoming bytes to a SharedArrayBuffer and calls `Atomics.notify()` to wake the Worker.

**DNS:** `host_getaddrinfo("example.com")` calls Node's `dns.lookup()` (async, Worker blocks via Atomics.wait until result arrives). Returns resolved IP bytes.

**HTTPS works automatically** — PHP's compiled-in OpenSSL does the TLS handshake over the raw TCP socket. The host just passes bytes through.

**Error mapping:** Node.js socket errors → errno: ECONNREFUSED, ETIMEDOUT, ECONNRESET, EPIPE.

## 4. Host-Side — Browser Fetch Backend

Translates socket operations into `fetch()` calls. HTTP only (port 80).

**Connection lifecycle:**

```
host_connect(handle, "93.184.216.34", 80)
  → store destination in Map<handle, ConnectionState>
  → ConnectionState = { ip, port, sendBuf: [], responseBuf: null, responseOffset: 0 }
  → return success immediately (no real connection yet — lazy)

host_send(handle, bytes, flags)
  → append bytes to ConnectionState.sendBuf
  → scan buffer for "\r\n\r\n" (end of HTTP headers)
  → if not found: return bytes.length (buffered, waiting for more)
  → if found:
      1. Parse request line: method, path, HTTP version
      2. Parse headers (especially Host, Content-Length, Content-Type)
      3. If Content-Length > 0, wait for body bytes too
      4. Once complete: construct URL from Host header + path
      5. Call fetch(url, { method, headers, body })
      6. Format response as raw HTTP bytes:
         "HTTP/1.1 200 OK\r\nContent-Length: N\r\n...\r\n\r\n<body>"
      7. Store in ConnectionState.responseBuf
  → return bytes.length

host_recv(handle, len, flags)
  → if responseBuf is null: block until fetch completes
  → slice responseBuf[responseOffset..responseOffset+len]
  → advance responseOffset
  → return bytes
```

**One request per connection** — matches PHP's typical socket usage for HTTP.

**CORS:** `fetch()` is subject to CORS. Accept an optional `corsProxyUrl` in config. Requests that fail CORS retry through the proxy.

**HTTPS (port 443):** Returns ECONNREFUSED in this initial implementation. Clear extension point for TLS MITM later.

## 5. DNS Resolution

musl's `getaddrinfo()` normally creates UDP sockets to query nameservers — not supported. We intercept at the kernel level.

**New syscall: `Getaddrinfo` (number 140)**

- Kernel reads hostname from Wasm memory, calls host
- Node.js: `dns.lookup(hostname)` → real IP
- Browser: DNS-over-HTTPS or synthetic mapping (fetch resolves DNS internally, but PHP needs a valid sockaddr_in)

**musl patch:** Override `__lookup_name()` in the overlay to call the getaddrinfo syscall instead of doing UDP-based DNS.

## 6. Error Handling

- **Timeouts:** Honor `SO_RCVTIMEO` — pass to host so `host_recv` returns `ETIMEDOUT` after deadline. Default: 30 seconds.
- **Connection failure:** `ECONNREFUSED` / `ETIMEDOUT` / `ENETUNREACH`. Browser fetch backend maps opaque `TypeError` to `ECONNREFUSED`.
- **HTTPS on browser:** Port 443 returns `ECONNREFUSED`. Extension point for TLS MITM later.
- **New errnos needed:** `ETIMEDOUT`, `ENETUNREACH` added to Errno enum.
- **Graceful degradation:** Networking HostIO methods are optional. If not implemented, AF_INET connect continues returning `ECONNREFUSED` — same as today.

## 7. Testing

**Kernel-side unit tests** (cargo, no real network):
- `sys_connect` on AF_INET calls `host_connect` mock, sets Connected state
- `sys_send` / `sys_recv` on AF_INET delegates to host mock
- AF_UNIX regression — still uses pipe-backed path
- Error propagation from host to caller
- `sys_getaddrinfo` returns packed sockaddr_in from mock

**Host-side unit tests** (vitest):
- Node.js TCP backend: test against local TCP server spawned in test
- Browser fetch backend: mock fetch, verify HTTP parsing (raw bytes → fetch call → raw response bytes)
- DNS: mock dns.lookup / DOH

**Integration tests** (optional, require network):
- Node.js full round-trip HTTP GET
- Skipped in CI by default, enabled with env var

## 8. Files Changed

### Kernel (Rust)
- `crates/shared/src/lib.rs` — Getaddrinfo syscall variant, ETIMEDOUT/ENETUNREACH errnos
- `crates/kernel/src/process.rs` — New HostIO trait methods
- `crates/kernel/src/syscalls.rs` — AF_INET branches in connect/send/recv, new sys_getaddrinfo
- `crates/kernel/src/wasm_api.rs` — New host imports + kernel exports

### Glue (C)
- `libc/glue/syscall_glue.c` — Getaddrinfo dispatch
- `libc/glue/syscall_imports.h` — New kernel import declarations
- `libc/musl-overlay/arch/wasm32posix/bits/syscall.h.in` — __NR_getaddrinfo

### Host (TypeScript)
- `host/src/types.ts` — NetworkBackend interface, PlatformIO network methods
- `host/src/kernel.ts` — Host imports for connect/send/recv/getaddrinfo
- `host/src/networking/tcp-backend.ts` — Node.js net.Socket backend (new file)
- `host/src/networking/fetch-backend.ts` — Browser fetch backend (new file)
- `host/src/networking/http-parser.ts` — Raw HTTP byte parsing (new file)

### musl overlay
- `libc/musl-overlay/src/network/lookup_name.c` — Override __lookup_name to use syscall (new file)
