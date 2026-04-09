# Virtual Network Stack: Raw Sockets, AF_PACKET, and smoltcp Integration

**Status:** Future work / Ideas document
**Date:** 2026-04-09

## Motivation

The kernel currently has no packet-level networking. AF_INET sockets jump directly to host callbacks (`host_net_connect`, `host_net_send`, etc.) for external connections, or use PipeBuffer pairs for localhost loopback. There are no raw sockets (`SOCK_RAW`), no link-layer capture (`AF_PACKET`), no ICMP, and no virtual network interface abstraction.

Adding a virtual network stack would enable:
- **nmap** — SYN scan, connect scan, ping sweep against kernel-hosted services
- **tcpdump / libpcap** — capture and filter inter-process traffic
- **ping / traceroute** — ICMP echo between kernel processes
- **netcat UDP** — full UDP communication
- Any **libpcap-based** tool (Wireshark dissectors, arpwatch, etc.)
- A more realistic POSIX platform where programs can inspect the network at every layer

## Current Architecture

### How AF_INET works today

```
Userspace: connect(fd, 127.0.0.1:80)
    │
    ▼
Kernel (sys_connect):
    ├─ Loopback (127.x.x.x)?
    │   ├─ Same-process: search socket table for listener, create PipeBuffer pair
    │   └─ Cross-process: search all ProcessTable entries, create global PipeBuffer pair
    │       (no host involvement — data flows through pipes)
    │
    └─ External?
        └─ host.host_net_connect(handle, addr, port)
            └─ Host NetworkIO (TcpNetworkBackend or FetchNetworkBackend)
```

Key observations:
- **Loopback is already kernel-internal** — no packets, no IP headers, just pipe-connected sockets
- **External goes straight to the host** — the kernel never sees IP/TCP headers
- **No packet layer exists** — there's nothing for raw sockets to tap into
- `SocketType` only has `Stream` and `Dgram` — `SOCK_RAW` returns `EPROTOTYPE`

### Host-side networking (for external connections)

```typescript
// host/src/kernel.ts — Wasm imports
host_net_connect(handle, addrPtr, addrLen, port) → NetworkIO.connect()
host_net_send(handle, bufPtr, bufLen, flags) → NetworkIO.send()
host_net_recv(handle, bufPtr, bufLen, flags) → NetworkIO.recv()
host_net_close(handle) → NetworkIO.close()
host_net_listen(fd, port, addr) → callbacks.onNetListen()
```

Node.js: `TcpNetworkBackend` uses real `net.Socket` with `Atomics.wait` for sync blocking.
Browser: `FetchNetworkBackend` converts TCP socket ops to HTTP `fetch()` requests.

## Proposed Architecture

### The split: virtual stack for localhost, host delegation for external

```
                    AF_INET socket operation
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
        Localhost (127.0.0.0/8)    External (all other)
                │                       │
                ▼                       ▼
        ┌───────────────┐      Host-delegated
        │ Virtual Stack │      (current behavior,
        │   (smoltcp)   │       unchanged)
        │               │
        │  IP layer  ◄──┼── SOCK_RAW taps here (full IP packets)
        │  TCP / UDP    │
        │  ICMP         │
        └───────┬───────┘
                │
        AF_PACKET taps here (IP frames on Medium::Ip)
                │
                ▼
          VirtualDevice
        (loopback queue)
```

### Why smoltcp

[smoltcp](https://github.com/smoltcp-rs/smoltcp) is a `#![no_std]` Rust TCP/IP stack designed for embedded systems. It's a natural fit:

- **Confirmed wasm32-unknown-unknown compatible.** `smoltcp = "0.12"` compiles cleanly with:
  ```bash
  cargo +nightly check --target wasm32-unknown-unknown --no-default-features \
    --features "alloc,medium-ip,proto-ipv4,socket-tcp,socket-udp,socket-icmp,socket-raw,socket-tcp-reno"
  ```
  Zero errors, zero warnings.

- **No unsafe code** (`#![deny(unsafe_code)]`), no libc, no std, no threading, no system calls
- **No system clock** — you supply timestamps: `iface.poll(Instant::from_millis(t), ...)`
- **Deterministic PRNG** for TCP sequence numbers (sPCG32, seeded via config)
- **All dependencies** (`managed`, `byteorder`, `heapless`, `bitflags`, `cfg-if`) are no_std
- Provides: TCP (full state machine with Reno CC), UDP, ICMP, raw IP sockets, ARP (optional)

### Cargo features for the kernel

```toml
[dependencies.smoltcp]
version = "0.12"
default-features = false
features = [
    "alloc",              # Vec-backed socket buffers (kernel already uses alloc)
    "medium-ip",          # Layer 3 (no Ethernet/ARP overhead for virtual loopback)
    "proto-ipv4",         # IPv4 protocol parsing
    "socket-tcp",         # TCP with full state machine
    "socket-udp",         # UDP datagrams
    "socket-icmp",        # ICMP echo (ping)
    "socket-raw",         # Raw IP sockets (SOCK_RAW / AF_PACKET capture)
    "socket-tcp-reno",    # Integer-only congestion control (no f64, ideal for wasm32)
]
```

Features to avoid: `std`, `phy-raw_socket`, `phy-tuntap_interface` (require libc), `medium-ethernet` (unnecessary for virtual loopback), `socket-tcp-cubic` (uses f64).

## Detailed Design

### 1. VirtualDevice (the loopback interface)

smoltcp's `Device` trait is the frame injection/extraction point. For virtual localhost, frames go out one side and loop back in:

```rust
use alloc::collections::VecDeque;
use alloc::vec::Vec;
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::time::Instant;

pub struct VirtualDevice {
    rx_queue: VecDeque<Vec<u8>>,  // Frames waiting to be processed by smoltcp
    tx_queue: VecDeque<Vec<u8>>,  // Frames produced by smoltcp
}

impl Device for VirtualDevice {
    type RxToken<'a> = VirtualRxToken;
    type TxToken<'a> = VirtualTxToken<'a>;

    fn receive(&mut self, _ts: Instant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        self.rx_queue.pop_front().map(|buf| {
            (VirtualRxToken { buffer: buf }, VirtualTxToken { queue: &mut self.tx_queue })
        })
    }

    fn transmit(&mut self, _ts: Instant) -> Option<Self::TxToken<'_>> {
        Some(VirtualTxToken { queue: &mut self.tx_queue })
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.max_transmission_unit = 65535;
        caps.medium = Medium::Ip;           // No Ethernet framing
        caps.checksum = ChecksumCapabilities::ignored(); // Virtual, no corruption possible
        caps
    }
}
```

With `Medium::Ip`, all frames are raw IP packets (no Ethernet headers, no MAC addresses, no ARP). For loopback, this is exactly right.

**Loopback routing:** After `iface.poll()`, drain `tx_queue` and push frames back into `rx_queue`. The next `poll()` delivers them to the destination socket. For localhost, every transmitted frame is immediately looped back.

### 2. smoltcp Interface setup

```rust
use smoltcp::iface::{Config, Interface, SocketSet};
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr};

let config = Config::new(HardwareAddress::Ip);
let mut iface = Interface::new(config, &mut device, Instant::from_millis(0));

iface.update_ip_addrs(|addrs| {
    addrs.push(IpCidr::new(IpAddress::v4(127, 0, 0, 1), 8)).unwrap();
});

let mut sockets = SocketSet::new(vec![]);
```

The interface owns one IP address (127.0.0.1/8). All localhost traffic routes through it.

**Polling:** Call `iface.poll(now, &mut device, &mut sockets)` during every syscall that touches the network. Time comes from the kernel's existing `current_time_millis()` via `host_clock_gettime`. No background threads needed — polling is synchronous during syscall handling.

### 3. Kernel integration: socket lifecycle

When userspace calls `socket(AF_INET, SOCK_STREAM, 0)`:

1. Create a `SocketInfo` as today (kernel-side bookkeeping)
2. **Also** create a `smoltcp::socket::tcp::Socket` with rx/tx ring buffers
3. Add it to the `SocketSet`, store the `SocketHandle` in `SocketInfo`

When userspace calls `connect(fd, 127.0.0.1:80)`:

1. Look up the smoltcp TCP socket by handle
2. Call `socket.connect(cx, remote_endpoint, local_endpoint)`
3. smoltcp generates a SYN packet → `tx_queue`
4. Loopback: move to `rx_queue`
5. `iface.poll()` → smoltcp delivers SYN to the listening socket, generates SYN-ACK → `tx_queue`
6. Loop until handshake completes (SYN → SYN-ACK → ACK)
7. Both sockets transition to `Established`

This replaces the current PipeBuffer-pair shortcut with real TCP packets flowing through the stack.

### 4. SOCK_RAW (AF_INET raw sockets)

Add `SocketType::Raw` to the kernel's socket enum. When userspace calls `socket(AF_INET, SOCK_RAW, IPPROTO_TCP)`:

1. Create a `smoltcp::socket::raw::Socket` with the protocol filter:
   ```rust
   raw::Socket::new(
       Some(IpVersion::Ipv4),
       Some(IpProtocol::Tcp),  // or None for all protocols
       rx_buffer, tx_buffer,
   )
   ```
2. Add to the `SocketSet`

smoltcp's `Interface::process_ipv4()` automatically delivers copies of matching packets to all raw sockets via `raw_socket.process()`. Raw sockets receive complete IP packets (IP header + payload).

**`sendto` on raw sockets:** Write complete IP packets (or just payload if not `IP_HDRINCL`) to the smoltcp raw socket's tx buffer. `iface.poll()` transmits them through the device.

**`IP_HDRINCL` socket option:** When set, userspace provides the full IP header. When not set, the kernel constructs the IP header. smoltcp's raw socket always works with full IP packets internally, so for non-`IP_HDRINCL` sends, the kernel prepends an IP header before writing to the raw socket.

### 5. AF_PACKET (link-layer capture)

Two implementation approaches:

#### Approach A: Device-level tap (recommended for Medium::Ip)

Since we control the `VirtualDevice`, intercept frames at the device level:

```rust
impl VirtualDevice {
    /// After poll(), drain TX frames. Copy to any registered AF_PACKET sockets.
    pub fn drain_tx_with_capture(&mut self, capture_sinks: &mut [PacketSink]) -> Option<Vec<u8>> {
        let frame = self.tx_queue.pop_front()?;
        for sink in capture_sinks.iter_mut() {
            if sink.matches(&frame) {  // BPF filter check
                sink.enqueue(frame.clone());
            }
        }
        Some(frame)
    }
}
```

AF_PACKET sockets see every IP frame entering or leaving the virtual interface. With `Medium::Ip`, these are raw IP packets (no Ethernet header), which maps to `AF_PACKET + SOCK_DGRAM` (cooked capture).

For full `AF_PACKET + SOCK_RAW` (Ethernet frames), we could optionally synthesize Ethernet headers (src/dst MAC, EtherType) around the IP packets before delivering to AF_PACKET sockets. Since the MACs are virtual, this is just bookkeeping — but it makes libpcap happy since it expects Ethernet framing in `DLT_EN10MB` mode. Alternatively, use `DLT_RAW` (raw IP, no link header) which libpcap also supports.

#### Approach B: smoltcp raw socket with protocol=None

A `raw::Socket::new(None, None, rx, tx)` captures all IP packets regardless of protocol. This piggybacks on smoltcp's existing socket dispatch rather than tapping the device. Simpler but less flexible — can't see packets before smoltcp processes them.

**Recommendation:** Use Approach A (device tap) for AF_PACKET, and smoltcp's built-in raw sockets for `SOCK_RAW`. This gives the cleanest separation: AF_PACKET = pre-stack frame capture, SOCK_RAW = protocol-filtered IP capture.

### 6. BPF (Berkeley Packet Filter)

libpcap/tcpdump compile filter expressions (e.g., `tcp port 80`) to classic BPF (cBPF) bytecode, attached via `setsockopt(SO_ATTACH_FILTER)`.

cBPF is a simple register machine:
- 2 registers (A = accumulator, X = index)
- ~30 opcodes: load from packet, load from memory, ALU, jump, return
- Program returns 0 (reject) or non-zero (accept, value = truncation length)

A cBPF interpreter is ~200-300 lines of Rust:

```rust
pub struct BpfProgram {
    instructions: Vec<BpfInsn>,
}

pub struct BpfInsn {
    code: u16,
    jt: u8,    // jump if true
    jf: u8,    // jump if false
    k: u32,    // constant
}

impl BpfProgram {
    /// Run the filter against a packet. Returns 0 to reject, >0 to accept.
    pub fn run(&self, packet: &[u8]) -> u32 {
        let mut a: u32 = 0;
        let mut x: u32 = 0;
        let mut mem = [0u32; 16]; // scratch memory
        let mut pc = 0;
        // ... interpret opcodes ...
    }
}
```

This gets attached to AF_PACKET sockets via `setsockopt(SOL_SOCKET, SO_ATTACH_FILTER, &bpf_prog)`.

### 7. Virtual interface ioctls and /proc/net

**Interface ioctls** (`SIOCGIFADDR`, `SIOCGIFFLAGS`, `SIOCGIFINDEX`, `SIOCGIFHWADDR`, `SIOCGIFMTU`):
Return static values for the virtual `lo` interface. These are read by libpcap during `pcap_open_live()`.

**procfs entries** (read-only virtual files):
- `/proc/net/tcp` — enumerate TCP connections from smoltcp's socket set
- `/proc/net/udp` — enumerate UDP bindings
- `/proc/net/dev` — interface stats (lo: packet/byte counts from VirtualDevice)
- `/proc/net/route` — routing table (127.0.0.0/8 → lo)
- `/proc/net/if_inet6` — empty (no IPv6)

These are needed by various networking tools (`ss`, `netstat`, nmap's interface enumeration).

## Migration Strategy

### Phase 1: Add smoltcp, SOCK_RAW, basic AF_PACKET

- Add smoltcp dependency to `crates/kernel/Cargo.toml`
- Create `crates/kernel/src/netstack.rs` with VirtualDevice + Interface setup
- Add `SocketType::Raw` to socket.rs
- Wire `socket(AF_INET, SOCK_RAW, proto)` to create smoltcp raw sockets
- Implement device-tap AF_PACKET capture
- Add `SO_ATTACH_FILTER` with cBPF interpreter
- **Localhost TCP/UDP continues using PipeBuffer pairs** (no migration yet)
- Raw sockets can see packets generated by a simple loopback echo path

This is useful on its own: a port scanner using SOCK_RAW + connect-then-observe, or a packet sniffer on the loopback.

### Phase 2: Migrate localhost TCP through smoltcp

- Replace PipeBuffer-pair loopback connections with smoltcp TCP sockets
- `sys_connect` to 127.0.0.1 → `smoltcp_socket.connect()` → poll loop → handshake
- `sys_send`/`sys_recv` on loopback → `smoltcp_socket.send_slice()`/`recv_slice()`
- `sys_listen`/`sys_accept` → smoltcp TCP listen + accept
- **High risk:** This changes the data path for all localhost connections (nginx↔PHP-FPM, MariaDB, Redis). Extensive testing required against all browser demos.
- Cross-process loopback: smoltcp's SocketSet is in the kernel (shared across all processes), so cross-process TCP works naturally — both ends are smoltcp sockets in the same Interface.

### Phase 3: ICMP, UDP, network tools

- Wire ICMP echo through smoltcp (ping between processes)
- Migrate localhost UDP from dgram_queue to smoltcp UDP sockets
- Port tcpdump + libpcap (libpcap needs: `pcap_open_live` → AF_PACKET socket, `pcap_setfilter` → BPF, `pcap_next` → recvfrom)
- Port nmap (complex C++ but feasible — primary dependency is libpcap)
- Add `/proc/net/*` virtual files

### Phase 4: Optional Ethernet emulation

- Add `medium-ethernet` support for programs that expect Ethernet framing
- Virtual MAC addresses, ARP table
- `DLT_EN10MB` capture mode for full libpcap compatibility
- Only needed if ported programs require it — `DLT_RAW` may suffice

## Risks and Considerations

### Performance

smoltcp TCP adds overhead vs. direct PipeBuffer pairs. Every localhost send/recv now involves:
1. Write to smoltcp socket buffer
2. `iface.poll()` generates TCP segment → IP packet → tx_queue
3. Loopback: tx_queue → rx_queue
4. `iface.poll()` parses IP → TCP → delivers to destination socket buffer
5. Read from destination socket buffer

vs. today's single PipeBuffer write/read. For high-throughput localhost paths (PHP-FPM ↔ nginx), this could be measurable. Mitigation: the current PipeBuffer path could be retained as a fast path when no raw/AF_PACKET sockets are listening, falling back to the full stack only when packet capture is active.

### Polling integration

smoltcp needs periodic polling for TCP timers (retransmission, keepalive, TIME_WAIT). The kernel currently processes syscalls synchronously. Options:
- Poll on every network-related syscall (sufficient for active connections)
- Poll on a timer via the existing setitimer/alarm infrastructure
- Poll from the host side between syscall completions

### Cross-process socket sharing

With PipeBuffers, cross-process loopback uses the global pipe table. With smoltcp, all sockets live in one SocketSet owned by the Interface. Cross-process sharing is simpler — both endpoints are just SocketHandles in the same set. But SocketHandle ownership/cleanup on process exit needs care.

### Wasm binary size

smoltcp with the proposed features adds to the kernel wasm binary. Estimated ~50-100KB compressed. The kernel is currently ~300KB, so this is meaningful but not prohibitive.

## Programs to Port

| Program | Dependencies | Value |
|---------|-------------|-------|
| Custom `portscan` | None (just SOCK_RAW or connect scan) | Immediate demo value |
| ping | ICMP raw socket | Classic networking tool |
| tcpdump | libpcap → AF_PACKET + BPF | Network debugging |
| nmap | libpcap, lua (optional), libssl (optional) | The flagship use case |
| netcat (OpenBSD nc) | Minimal | General networking utility |
| traceroute | ICMP + raw sockets | Network diagnostics |

## Open Questions

1. **DLT_RAW vs DLT_EN10MB:** Can libpcap/tcpdump work with `DLT_RAW` (no Ethernet headers), or do they require full Ethernet framing? If `DLT_RAW` works, we can skip Ethernet emulation entirely.

2. **Dual-path optimization:** Should we keep the PipeBuffer fast path for localhost TCP when no raw sockets are listening? This avoids the performance regression for the common case but adds code complexity.

3. **External traffic capture:** Should AF_PACKET also see packets for external (host-delegated) connections? This would require the host to synthesize IP/TCP headers for data flowing through `NetworkIO`, which is architecturally messy but would let tcpdump capture all traffic.

4. **smoltcp version:** 0.12 is confirmed working on wasm32. 0.13 (unreleased) has a nightly compatibility issue with `Ipv4Address::from_octets()`. Pin to 0.12 for now.
