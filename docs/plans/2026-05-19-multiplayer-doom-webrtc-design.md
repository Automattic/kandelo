# Multiplayer DOOM over WebRTC DataChannel — Design

Date: 2026-05-19
Branch: `explore-webrtc-doom-xl7dh`
Companion of: [`2026-05-05-explore-webrtc-data-channel-design.md`](./2026-05-05-explore-webrtc-data-channel-design.md)

## §1. Goals & non-goals

**Goal.** A 2-player deathmatch (or co-op) game of DOOM between two browsers on two different machines — first on a LAN, then between two homes — where the byte path is a peer-to-peer `RTCDataChannel`, the game binary is the existing `fbdoom.wasm` running in `wasm-posix-kernel`, and the IWAD is the freely-redistributable `freedoom1.wad` already shipped by `packages/registry/fbdoom/build-fbdoom.sh`.

The DOOM shareware IWAD (`doom1.wad`) is multiplayer-capable — Episode 1 ("Knee Deep in the Dead") supports both `-deathmatch` / `-altdeath` and 2-to-4-player co-op since the v1.0 release. `freedoom1.wad` honours the same map slots and is multiplayer-capable in the same modes. We pick DOOM because (a) the IWAD is free and tiny, (b) the netcode is small enough to study end-to-end, and (c) the source port we already ship (`maximevince/fbDOOM`) exposes the original id-Software `i_net.c` interface that we will fill in.

**Why this exists.** This is the user's chosen end-to-end test for the staged WebRTC roadmap (LAN-first, then cross-country) that started with the manual-SDP chat demo on this branch. Multiplayer DOOM is a deliberately stressful workload for that roadmap because it needs **unreliable+unordered datagram semantics** (matching `SOCK_DGRAM` over UDP) — the same gap the upstream WebRTC plan calls out at the bottom of its "out-of-scope follow-ups" list.

**Concretely, two ground-truth questions this validates:**

1. Can a two-half relay (`RelayChannel` on the main thread + `RelayHostShim` on the kernel-worker) bridge an `RTCDataChannel` to the kernel's existing UDP machinery cleanly enough that a real BSD-sockets game (fbDOOM) does no project-specific work?
2. Does the resulting round-trip latency stay inside DOOM's per-tic budget (~28 ms at 35 Hz) on a LAN, and remain playable across two homes via STUN?

**Non-goals (v1).**

- **No 3+ player support.** DOOM netplay supports up to 4 peers; v1 ships 2-peer only because (a) the signaling page only has to handle one offer/answer pair, and (b) the kernel relay only has to manage one DataChannel per process.
- **No TURN.** Same as the upstream design: STUN only, symmetric NATs fail. Cross-country validation may surface this; if so it lands in the follow-up TURN PR.
- **No spectator / observer mode.** Two playing peers, period.
- **No new IWAD distribution.** `freedoom1.wad` is what the existing fbDOOM build script fetches; the user may substitute their own `doom1.wad`. We do not add Doom 2 / Heretic / Hexen support.
- **No save-game sync, no replay, no demos.** The original DOOM `-record` flag isn't wired into the multiplayer path here.
- **No matchmaking.** Manual SDP only in v1, exactly like the chat demo. The "real signaling server" follow-up in the upstream plan still applies.
- **No anti-cheat.** Pairing is consensual; both peers run the same binary.
- **No audio over the channel.** Audio is local-only (fbDOOM already uses the null audio frontend via `NOSDL=1`).
- **No Chocolate-Doom-wire-format compatibility.** Both peers run **the same fbDOOM build** out of the same browser bundle; the on-the-wire packet format only has to be internally consistent. (Cross-port interop with stock Chocolate Doom is an interesting follow-up but is explicitly not promised here.)

**Success criteria.**

1. Two laptops on the same WiFi load `https://<host>/pages/doom-mp/`. Following the on-page instructions, the user pastes SDP blobs both ways (same flow as the chat demo). Within ~30 seconds, both browsers reach `connectionState === "connected"` *and* both fbDOOM instances have advanced past the netgame sync screen ("waiting for player 2…") into actual gameplay.
2. Each player sees the other player's marine move in their viewport; firing a rocket on machine A kills the player on machine B; the kill log on both sides agrees.
3. The per-tic round-trip stays under 50 ms on the LAN. The status panel surfaces a live WebRTC RTT number (the same 1 Hz ping-pong probe the chat demo already uses). Per-tic-level RTT and packet-loss instrumentation require cross-Wasm-boundary stats plumbing not yet built; both are explicit follow-ups (§10).
4. Quitting on one side (Esc → Quit) cleanly tears the game down on the other side instead of hanging on `D_QuitNetGame`.

## §2. Architecture

The relay sits on the page main thread (where `RTCPeerConnection` and `RTCDataChannel` live — they are not transferable to a worker). It is wired into the running kernel via the same cross-thread pattern that browser-side TCP ingress already uses: `kernel.injectConnection(...)` for inbound TCP becomes `kernel.injectDatagram(...)` for inbound UDP. Outbound, the kernel calls a new `HostIO::send_dgram` host hook whose kernel-worker implementation forwards the datagram to the main thread, which calls `channel.send(envelope)`.

```
   Browser A (player 1, "server"/"client 0")                       Browser B (player 2, "client 1")
   ─────────────────────────────────────────                       ────────────────────────────────
                              Manual SDP exchange (pages/doom-mp/main.ts, role-aware)
                                                        │
                                  RTCDataChannel "doom" — unreliable, unordered
                                  {ordered:false, maxRetransmits:0, negotiated:true, id:1}
                                                        │
   ┌─────────────────── main thread ──────────────────┐     ┌─────────────────── main thread ──────────────────┐
   │ pages/doom-mp/main.ts                            │     │ pages/doom-mp/main.ts                            │
   │  ├─ RelayChannel (owns the RTCDataChannel)       │     │  ├─ RelayChannel (owns the RTCDataChannel)       │
   │  │   • onmessage → kernel.injectDatagram(pid,port,…)│  │  │   • onmessage → kernel.injectDatagram(pid,port,…)│
   │  │   • on host-send-dgram msg → channel.send(env)│     │  │   • on host-send-dgram msg → channel.send(env)│
   │  └─ canvas + keyboard input (same as pages/doom/)│     │  └─ canvas + keyboard input (same as pages/doom/)│
   └──────────────┬────────────────────────────┬──────┘     └──────────────┬────────────────────────────┬──────┘
                  │ injectDatagram             │ host_send_dgram msg       │ injectDatagram             │ host_send_dgram msg
                  ▼                            ▲                           ▼                            ▲
   ┌────────────── kernel-worker thread ──────────────┐     ┌────────────── kernel-worker thread ──────────────┐
   │ kernel-wasm                                      │     │ kernel-wasm                                      │
   │  • kernel_inject_datagram(…) → pushes datagram   │     │  • kernel_inject_datagram(…) → pushes datagram   │
   │     onto the bound SOCK_DGRAM's dgram_queue      │     │     onto the bound SOCK_DGRAM's dgram_queue      │
   │  • sys_sendto on non-loopback → HostIO::send_dgram│    │  • sys_sendto on non-loopback → HostIO::send_dgram│
   │ RelayHostShim (implements HostIO::send_dgram):   │     │ RelayHostShim (implements HostIO::send_dgram):   │
   │  postMessage to main: { type:"host-send-dgram", …}│    │  postMessage to main: { type:"host-send-dgram", …}│
   └──────────────┬───────────────────────────────────┘     └──────────────┬───────────────────────────────────┘
                  │ kernel block/wake (existing dgram_queue path)           │ same
                  ▼                                                         ▼
   ┌────────────── process-worker thread ─────────────┐     ┌────────────── process-worker thread ─────────────┐
   │ fbdoom.wasm (pid N)                              │     │ fbdoom.wasm (pid N)                              │
   │   d_net.c → i_net_posix.c                        │     │   d_net.c → i_net_posix.c                        │
   │     socket(AF_INET, SOCK_DGRAM)                  │     │     socket(AF_INET, SOCK_DGRAM)                  │
   │     bind(0.0.0.0:5029)                           │     │     bind(0.0.0.0:5029)                           │
   │     sendto(10.99.0.2:5029, …)                    │     │     sendto(10.99.0.1:5029, …)                    │
   │     recvfrom(…)                                  │     │     recvfrom(…)                                  │
   └──────────────────────────────────────────────────┘     └──────────────────────────────────────────────────┘

                                                ▼ unreliable wire (RTCDataChannel) ▲
                                                └──────── peer-to-peer SCTP ───────┘
```

**The five moving pieces:**

1. **`i_net_posix.c`** — a chocolate-doom-style replacement for fbDOOM's existing `i_net.c`. Uses **only** POSIX BSD sockets (`socket`, `bind`, `sendto`, `recvfrom`, `setsockopt(SO_REUSEADDR)`, `select`/`poll`). No SDL_net, no project-specific syscalls. fbDOOM's `d_net.c` is already chocolate-doom-shaped (uses `loop_interface_t`, `D_RegisterLoopCallbacks`, `InitConnectData` with WAD checksums) so the new file is lifted from chocolate-doom's `net_sdl.c`/`net_loop.c` collapsed into one. Realistic size ~400-600 LOC. The relay layer below is invisible to the game.

2. **`kernel_inject_datagram`** (new kernel-wasm export) — modelled on `kernel_inject_connection` (`crates/kernel/src/wasm_api.rs:9219`, exposed in JS at `host/src/browser-kernel-host.ts:603-618`), but **addresses by `(pid, dst_port)` rather than `(pid, listener_fd)`**: signature `kernel_inject_datagram(pid: u32, dst_port: u32, src_ip_a..d: u32, src_port: u32, data_ptr: *const u8, data_len: u32) -> i32`. The kernel scans the addressed process's `proc.sockets` for the bound DGRAM socket on `dst_port` (mirroring `sys_sendto`'s loopback scan at `syscalls.rs:6074-6088`), then pushes the datagram onto that socket's `dgram_queue` (the same FIFO `sys_sendto` already populates for loopback at `syscalls.rs:6090-6097`) and wakes any `sys_recvfrom` blocked on that socket via the existing block/wake machinery — no new SAB ring buffer needed. **Port-based addressing means we do NOT need a new "host learns of DGRAM bind" notification** (the TCP analogue is `host_net_listen` called from `sys_listen` at `syscalls.rs:5670`). The page already knows the pid (it spawned fbDOOM) and the bound port (5029, baked into the `-server` / `-connect` CLI flags), so fd discovery is moot.

3. **`HostIO::send_dgram`** (new trait method on the kernel↔host interface) — added in `crates/kernel/src/process.rs` next to the existing trait body at L25 (`host_net_*` methods at L96-113), **with a default impl returning `Err(Errno::ENETUNREACH)`** so every existing concrete impl (`WasmHostIO` in `wasm_api.rs:169` + the in-test mocks in `syscalls.rs`) compiles unchanged. Only `WasmHostIO` overrides it; the override delegates to a new wasm host import `host_send_dgram` declared in the `extern "C"` block at `wasm_api.rs:38`. The Node and Browser kernel-worker host adapters provide that import: Node returns `-ENETUNREACH` immediately; Browser routes to the `RelayHostShim`. The kernel's `sys_sendto` calls the trait method when `dst_ip != 127.0.0.1` (replacing the current ENETUNREACH branch at `syscalls.rs:6066-6068`). Fire-and-forget; UDP is unreliable by definition. **The new `kernel_inject_datagram` export regenerates `abi/snapshot.json` as a backward-compatible additive change; per `docs/abi-versioning.md` (PR #490), `ABI_VERSION` is NOT bumped. The new `host_send_dgram` import is not tracked in the snapshot at all. The `HostIO::send_dgram` trait method is internal Rust API and is not snapshotted either.**

4. **`RelayChannel`** (new TS module on the main thread, `apps/browser-demos/lib/relay-network-backend.ts`) — owns the open `RTCDataChannel`, parses envelopes off `onmessage`, calls `kernel.injectDatagram(...)`, and handles outbound by listening for the kernel-worker's `host-send-dgram` messages and calling `channel.send(envelope)`. **Lives in `apps/browser-demos/lib/` next to `connection-pump.ts` (the existing cross-thread bridge that also is not a `NetworkIO` impl), NOT in `host/src/networking/`.** (Note: the post-#492 reorganization moved `tls-network-backend.ts` *into* `host/src/networking/` even though it's browser-only. The placement rule is now "NetworkIO impls live in `host/src/networking/`; non-NetworkIO cross-thread bridges live in `apps/browser-demos/lib/`" — relay-network-backend is the latter.) The name "Backend" is kept for symmetry with `TlsNetworkBackend` but this is not a `NetworkIO` implementation (see §4).

5. **Synthetic LAN + `pages/doom-mp/`** — both kernels are told they live on a tiny private subnet. The "server" peer is `10.99.0.1`, the "client" is `10.99.0.2`. The page (a) does the manual-SDP handshake (re-using as much as is sensible from `pages/webrtc/`), (b) sets `localAddr` based on the Host/Join radio, (c) constructs the `RelayChannel` over the open DataChannel, (d) spawns `fbdoom.wasm` with the correct multiplayer CLI flags, and (e) hosts the framebuffer canvas + keyboard input exactly like `pages/doom/`. `getaddrinfo("doom-peer")` resolves to the other peer's synthetic IP (handled by `RelayChannel` at the main-thread / signaling level; see §5).

**Why "negotiated:true, id:1" on the channel.** Manual SDP and `pc.createDataChannel(...)` together require one side to be the creator and one to be the observer (`ondatachannel`). With `negotiated:true, id:1`, both peers call `createDataChannel("doom", {negotiated:true, id:1, ordered:false, maxRetransmits:0})` and the channel is open as soon as the underlying transport is — eliminating one source of asymmetric bugs and matching what we want for symmetric game peers. (The chat demo uses the asymmetric pattern because it was demonstrating the offer/answer dance; for the game we want symmetry.)

## §3. Where it lives

```
crates/kernel/src/
├── process.rs                            ← modified — add HostIO::send_dgram
│                                            trait method (next to host_net_*
│                                            at L96-113) with a default impl
│                                            returning Err(Errno::ENETUNREACH)
│                                            so existing impls compile unchanged.
├── syscalls.rs                           ← modified — sys_sendto (L6023) calls
│                                            HostIO::send_dgram for non-loopback
│                                            destinations (currently L6066-6068
│                                            returns ENETUNREACH). sys_recvfrom
│                                            unchanged: the kernel-side
│                                            dgram_queue + block/wake machinery
│                                            already does the right thing once
│                                            inbound datagrams arrive.
├── wasm_api.rs                           ← modified —
│                                            (a) add `host_send_dgram` to the
│                                                extern "C" host-imports block
│                                                at L38;
│                                            (b) implement the new HostIO::send_dgram
│                                                method on WasmHostIO (impl at L169,
│                                                mirroring host_net_listen at L630-642);
│                                            (c) add kernel_inject_datagram export
│                                                next to kernel_inject_connection
│                                                at L9219 — signature in §2.
└── lib.rs                                ← no edits expected; exports are
                                            declared in wasm_api.rs.

crates/shared/src/
└── lib.rs                                ← NOT modified. ABI_VERSION (currently 11)
                                            does NOT bump. Per docs/abi-versioning.md
                                            (post-PR #490), adding a single new
                                            kernel-wasm export with no edits to
                                            existing exports is backward-compatible.

abi/
└── snapshot.json                         ← regenerated by
                                            `scripts/check-abi-version.sh update`
                                            in Task 1's commit. Expected drift:
                                            +1 entry in `kernel_exports`
                                            (kernel_inject_datagram). The new
                                            host_send_dgram import is NOT tracked
                                            in the snapshot.

packages/registry/fbdoom/
└── patches/
    └── 0002-i_net-posix.patch            ← new — replaces i_net.c with a
                                            chocolate-doom-shaped BSD-sockets
                                            driver, adds -connect / -server
                                            CLI parsing in d_main.c.

apps/browser-demos/
├── lib/
│   └── relay-network-backend.ts         ← new — main-thread `RelayChannel`:
│                                            owns the RTCDataChannel, calls
│                                            kernel.injectDatagram on inbound,
│                                            listens for host-send-dgram
│                                            messages and calls channel.send
│                                            on outbound. Sibling of
│                                            connection-pump.ts (the existing
│                                            cross-thread bridge that also
│                                            isn't a NetworkIO impl).
├── pages/
│   └── doom-mp/                          ← new
│       ├── index.html                    ← page shell, SDP textareas, role
│       │                                   selector, canvas, keyboard help
│       ├── main.ts                       ← signaling + relay wiring + spawn
│       ├── doom-mp.css                   ← reuse layout.css; small overrides
│       └── README.md                     ← LAN HTTPS setup (links to webrtc
│                                           README) + how to play
└── vite.config.ts                        ← +1 entry in rollupOptions.input

host/src/
├── browser-kernel-host.ts                ← modified — expose injectDatagram
│                                            alongside the existing
│                                            injectConnection (L603-618);
│                                            forward host-send-dgram messages
│                                            from the kernel-worker to any
│                                            registered RelayChannel. Use the
│                                            fire-and-forget sendToKernel pattern
│                                            at L644-671, not the request/response
│                                            pattern of injectConnection.
├── browser-kernel-worker-entry.ts        ← modified — near the existing
│                                            TlsNetworkBackend instantiation at
│                                            L339, instantiate the kernel-worker-
│                                            side RelayHostShim and wire it into
│                                            the kernel's HostIO callsites; route
│                                            incoming kernel_inject_datagram
│                                            requests.
└── kernel-worker.ts                      ← modified — dispatcher for the
                                            host_send_dgram host call. Landmark
                                            to mirror is onNetListen at L1131.

docs/
├── architecture.md                       ← short section: "WebRTC relay backend"
├── browser-support.md                    ← list the new demo, note SOCK_DGRAM
│                                            now has a working browser-side host
│                                            via the relay
└── abi-versioning.md                     ← referenced (procedure unchanged)
                                            for the additive snapshot regen.
```

**This change regenerates `abi/snapshot.json` but does NOT bump `ABI_VERSION`. The structural snapshot change is one new kernel-wasm export (`kernel_inject_datagram`) — backward-compatible per `docs/abi-versioning.md`'s additive-snapshot policy (PR #490). The new kernel-wasm import (`host_send_dgram`) is not tracked in the snapshot at all. The new `HostIO::send_dgram` trait method is internal Rust API and is also not snapshotted.** The `sys_sendto` / `sys_recvfrom` syscall numbers are unchanged; the change is to what those syscalls dispatch to internally. `test_udp_loopback` continues to pass (loopback path is unchanged). The user-space POSIX surface is identical.

No new npm dependencies. No SDK changes. fbDOOM still uses only POSIX libc.

## §4. Why UDP does NOT go through `NetworkIO`

The first draft of this design proposed extending `NetworkIO` (in `host/src/types.ts`) with optional `bindDgram?` / `sendto?` / `recvfrom?` methods. On verification that approach falls apart:

1. **`NetworkIO` lives on the kernel-worker thread.** The browser's existing `TlsNetworkBackend` is instantiated inside `host/src/browser-kernel-worker-entry.ts:339`, where the kernel's syscall dispatch can call it synchronously. **`RTCDataChannel` cannot live there** — `RTCPeerConnection` and the channels it creates are not transferable; they're bound to the realm (the page main thread) that created them. So an `RTCDataChannel`-owning backend cannot implement `NetworkIO`'s contract directly.

2. **Sync `recvfrom` via `Atomics.wait` is Node-shaped.** `TcpNetworkBackend` (`host/src/networking/tcp-backend.ts`) uses `Atomics.wait` because `net.Socket` callbacks fire on the same thread as the syscall caller. In the browser, `channel.onmessage` fires on the main thread while the syscall caller is in the process-worker thread. The notify cannot be wired the same way without bouncing through `postMessage`, and bouncing through `postMessage` is exactly what the existing `injectConnection` path already does cleanly.

3. **Existing cross-thread network ingress already uses inject-style hooks**, not `NetworkIO`. See `apps/browser-demos/lib/connection-pump.ts:30-61` for inbound HTTP via `kernel.injectConnection()` + `kernel.pipeWrite()` + `kernel.wakeBlockedReaders()`. Extending the same pattern for UDP keeps one architecture instead of two.

For all three reasons, **UDP gets a separate path: `kernel_inject_datagram` (inbound, called from main thread) and `HostIO::send_dgram` (outbound, called from the kernel)**. `NetworkIO` keeps its TCP-only shape; no optional methods, no nullable returns, no `?` ambiguity for callers. The TCP backends (`TcpNetworkBackend`, `FetchNetworkBackend`, `TlsNetworkBackend`) are completely untouched.

If a future feature needs raw `SOCK_RAW` or ICMP or some other non-TCP transport, it follows this same precedent: own host-call surface, own cross-thread bridge, own ABI bump. The interface-of-optional-methods is rejected as a design pattern for this codebase.

## §5. The relay backend in detail

The relay is split across two threads. There is **no** `Atomics.wait` in user code — the kernel's existing `dgram_queue` + block/wake machinery already handles the syscall blocking case once datagrams arrive via `kernel_inject_datagram`.

### §5.1 Main-thread half — `RelayChannel`

Lives in `apps/browser-demos/lib/relay-network-backend.ts`. Constructed by the demo page after the WebRTC handshake completes, before `kernel.spawn(fbdoom)`:

```ts
new RelayChannel({
  kernel: BrowserKernel,        // for kernel.injectDatagram(...)
  channel: RTCDataChannel,      // already-open, negotiated, unordered
  localAddr: [10, 99, 0, 1],    // this peer's synthetic IPv4
  peerAddr: [10, 99, 0, 2],     // the remote peer's synthetic IPv4
});
```

Responsibilities:

- **Inbound:** registers `channel.onmessage`. Parses the 7-byte envelope (see §5.3). On a UDP_DATAGRAM message, calls `kernel.injectDatagram(targetPid, dstPort, peerAddr, srcPort, payload)`. **This call is fire-and-forget — synchronous `postMessage` to the kernel-worker, no `requestId`, no awaited Promise**, unlike the `kernel.injectConnection` precedent at `host/src/browser-kernel-host.ts:603-618` which is async-with-response. At DOOM's ~35 Hz packet cadence, a per-packet round-trip would cost ~35 Promise allocations + 70 thread hops per second per peer with no useful return value to consume (a drop is just a drop, exactly like wire loss). The kernel-wasm export pushes the datagram into the matching bound SOCK_DGRAM's `dgram_queue` and wakes any `sys_recvfrom` blocked on that socket. If the export returns nonzero (no bound socket, bad pid), the kernel-worker logs it once but does not surface it to the page — the relay is best-effort.
- **Outbound:** registers a listener on `BrowserKernel` for `host-send-dgram` messages forwarded from the kernel-worker (see §5.2). On receipt, encodes the envelope and calls `channel.send(envelope)`. Fire-and-forget; the channel itself is unreliable.
- **DNS-equivalent:** `getaddrinfo("doom-peer")` is resolved at the page level before `fbdoom.wasm` is spawned (the page knows `peerAddr` from the role radio). The synthetic name is wired into fbDOOM via the `-connect <ip>` CLI flag, not via runtime DNS. (Concrete: the Host peer passes `-server`; the Join peer passes `-connect 10.99.0.1`. fbDOOM never calls `getaddrinfo` for this address.)
- **Cleanup:** when the user closes the page, `RelayChannel.close()` drops the channel reference and unregisters listeners. The kernel-worker side detects channel-closed via a kernel-internal signal (out of scope here — fbDOOM's `-quit` path or `D_QuitNetGame` handles graceful exit; the ungraceful case is in §G of the review and is a separate UX follow-up).

### §5.2 Kernel-worker half — `RelayHostShim`

Lives in `host/src/browser-kernel-worker-entry.ts` (added near the existing `TlsNetworkBackend` instantiation at L339). Implements the new `HostIO::send_dgram` trait method:

```ts
class RelayHostShim {
  send_dgram(src_port: number, dst_ip: Uint8Array, dst_port: number, data: Uint8Array): number {
    // Post to main thread; main thread's RelayChannel does the actual send.
    // src_port is forwarded so the RelayChannel can place it in the wire envelope (§5.3).
    self.postMessage({ type: "host-send-dgram", src_port, dst_ip, dst_port, data });
    return data.length;
  }
}
```

Fire-and-forget; UDP is unreliable, so a `postMessage` race during channel close is acceptable (drops the packet, just like a wire-level loss). The kernel does not block waiting for confirmation.

### §5.3 Wire envelope

The wire envelope is a 7-byte header + payload:

```
offset  size  field
0       1     type      // 0x01 = UDP_DATAGRAM (other values reserved)
1       4     srcPort+pad  // bytes 1-2: srcPort (big-endian); bytes 3-4: 0 (reserved)
                          // — see note below
5       2     dstPort   // big-endian
7       n     payload
```

The receiver knows the channel terminates at exactly one peer (whose synthetic IP it already knows from `peerAddr`) so the source address does not need to be on the wire. The source *port* IS on the wire — that's the value the receiver writes into the `from_addr` of `recvfrom`, which DOOM's `i_net_posix.c` uses to address reply packets. Bytes 3-4 are reserved for forward compatibility (later mesh routing may need a peer-id).

(The first draft of this design had a 4-byte `dstAddr` field; in the point-to-point case it was unused. Replacing the unused 4-byte slot with a 2-byte srcPort + 2 bytes reserved is strictly more useful at the same envelope size.)

### §5.4 Why we don't reuse the chat-page's text protocol

The chat demo sends raw strings as chat (and JSON envelopes for ping/pong). DOOM packets are binary. We bind a *new* DataChannel for the game (`label:"doom"`) on a separate `id`, not the chat channel. The chat channel could coexist on the same `RTCPeerConnection` if we ever want in-game chat, but v1 doesn't.

### §5.5 MTU

WebRTC DataChannel SCTP MTU is conservatively 1200 bytes per outgoing PDU in unreliable mode (`maxRetransmits:0`). Fragmentation in unreliable mode is broken-by-design: a lost SCTP fragment destroys the whole message because `maxRetransmits:0` means there is no retransmission to repair it. DOOM netcode packets are tiny (< 100 bytes typical) so this is a guardrail, not a real constraint. The relay asserts `payload.length + 7 <= 1024` in debug builds and logs (without throwing) in release. The 1024 cap leaves ~15% headroom under the SCTP MTU floor; it is measured by inspection of the Chromium SCTP implementation rather than promised by the WebRTC spec, so the assertion is documented as a known floor, not a guaranteed maximum.

## §6. The fbDOOM patch

fbDOOM's `d_net.c` is full-featured and **chocolate-doom-shaped** — it uses `loop_interface_t`, `D_RegisterLoopCallbacks`, `InitConnectData` (which marshals WAD checksums + game settings), and delegates the transport to `i_net.c`. The existing `i_net.c` is a stub; this PR replaces it. (The first draft of this design called fbDOOM's interface "vanilla id-Software shape"; on inspection it's actually chocolate-doom's interface vendored in. Functionally identical for our purposes but worth being accurate about.) The patch:

1. **Replaces** `fbdoom/i_net.c` with a chocolate-doom-style `i_net_posix.c` that uses `socket(AF_INET, SOCK_DGRAM, 0)`, `bind`, `sendto`, `recvfrom`, `select` on a single fd. Realistic size ~400-600 LOC — fbDOOM's `d_net.c` is already chocolate-doom-shaped (uses `loop_interface_t`, `D_RegisterLoopCallbacks`, `InitConnectData` with WAD checksums) so the new file is lifted from chocolate-doom's `net_sdl.c` + `net_loop.c` collapsed into one. Larger than the first draft's "~250 LOC" estimate but still tightly bounded.
2. **Wires** `-server` (this peer is `client 0`, waits for the other to dial in) and `-connect 10.99.0.X` (dial in to `10.99.0.X:5029`) into `d_main.c::D_DoomMain` argument parsing. These flags are conventional in the doomworld ecosystem — choosing them keeps the eventual cross-port interop story open.
3. **Sets `netgame = true; multiplayer = true; consoleplayer = 0|1` accordingly**, plus translates `-deathmatch` / `-altdeath` (already understood by stock id code) into `deathmatch = 1|2`.
4. **No changes** to the rendering or the input pipeline. Multiplayer DOOM displays the other player as a marine sprite using exactly the same `R_DrawSprites` path as single-player.

The patch lives in `packages/registry/fbdoom/patches/0002-i_net-posix.patch` next to the existing `0001-fix-I_InitInput-signature.patch`. The build script's existing patch loop (`build-fbdoom.sh:41-54`) applies it without modification. fbDOOM still calls only POSIX libc symbols — the kernel ABI surface change in this PR is the additive new `kernel_inject_datagram` export and the new `HostIO::send_dgram` host call (§3), neither of which is visible to user-space programs like fbDOOM and neither of which triggers an `ABI_VERSION` bump.

## §7. The user flow

Two participants — **A** (host, "client 0") and **B** (joiner, "client 1").

1. Both load `https://<lan-ip-or-tailnet>/pages/doom-mp/` (HTTPS required, same constraint as the chat demo — see `pages/webrtc/README.md`).
2. A picks the **Host** radio button. B picks the **Join** radio button. (This sets `localAddr` to `10.99.0.1` vs `10.99.0.2` and decides who passes `-server` vs `-connect 10.99.0.1` to fbDOOM.)
3. A clicks **Create offer** → SDP appears → A sends it to B over chat/email/etc.
4. B pastes A's SDP, clicks **Accept offer** → B's SDP appears → B sends it back.
5. A pastes B's SDP, clicks **Accept answer**.
6. Both pages reach `connected`. The page now reads:

   > Game channel open. Click **Start DOOM** to launch.
7. Both peers click **Start DOOM** (within a few seconds of each other; the netgame sync screen will wait). Page boots `BrowserKernel`, lazy-registers the WAD (same as `pages/doom/`), constructs the `RelayChannel` over the open DataChannel (which simultaneously instantiates the kernel-worker-side `RelayHostShim` via the kernel-worker init message), then spawns `fbdoom.wasm` with either `["-server", "-deathmatch", "-warp", "1", "1"]` or `["-connect", "10.99.0.1", "-deathmatch", "-warp", "1", "1"]`.
8. fbDOOM's standard netgame banner appears on both sides ("waiting for player 2…"). Once both peers have exchanged the initial `setup` packets, the game proceeds to E1M1 in deathmatch mode with both marines spawned at the deathmatch starts.

**Bring-up race (expected, self-healing).** If peer A's fbDOOM sends its first sync packet before peer B's `RelayChannel` is constructed (B hasn't clicked **Start DOOM** yet) — or, more subtly, after B's `RelayChannel` exists but before B's fbDOOM has called `bind(5029)` so the kernel scan finds no matching socket — the inject returns `-ECONNREFUSED` and the packet is dropped. DOOM's `D_CheckNetGame` retries the sync handshake periodically, so this self-heals as soon as both sides are ready. Users will see "waiting for player 2…" for up to a few seconds longer than the strict-simultaneous-click case; this is the netcode working as designed, not a relay bug.

The page surfaces one live number in the status panel: WebRTC RTT, reusing the 1 Hz `{t:"ping",ts}` / `{t:"pong",ts}` JSON probe the chat demo already implements (`apps/browser-demos/pages/webrtc/main.ts`). Per-tic-level RTT and packet-loss percentage are explicitly **not** surfaced in v1 — they would require a new cross-Wasm-boundary stats channel (e.g., a stats syscall the patch calls, or a magic stdout protocol) and are out of scope (§10).

## §8. STUN / NAT / cross-country behavior

Identical to the chat demo's analysis (`2026-05-05-explore-webrtc-data-channel-design.md` §5), and re-stated here only to note one DOOM-specific concern:

DOOM's 35 Hz tic rate gives a per-tic budget of ~28 ms. Direct LAN host-host pairs trivially clear this. Cross-country `srflx` pairs at ~50–80 ms RTT will produce visibly jittery gameplay but still progress (the netcode tolerates 8 buffered tics by default). Sustained packet loss > 5% turns the game into a slideshow as the netcode re-requests dropped commands. If symmetric-NAT users fall back to TURN once we ship it, expect another 10–30 ms each way through the relay.

Sustained network problems will surface as visible game stutter rather than as a measured number — v1 does not surface packet loss in the UI (see §10 for the follow-up that would). The user's diagnostic for "is this the network or a bug?" in v1 is the WebRTC RTT readout: if it's >100 ms or noisy, that's almost certainly the network.

**Tab backgrounding.** Browsers throttle `setTimeout` / `setInterval` / `requestAnimationFrame` on backgrounded main threads but **not** `RTCDataChannel.onmessage` (event-dispatched, not timer-gated) and **not** worker timers nearly as aggressively. fbDOOM runs in a process-worker, so gameplay continues at full speed in the background — only canvas paint via `rAF` lags, and the 1 Hz RTT probe (a `setInterval`) goes to ~1 sample / minute. Net effect for the user: a backgrounded tab plays correctly but the canvas may look frozen until it's foregrounded again. Worth documenting; not a non-goal, not a v1 blocker.

## §9. Open questions

To settle in the plan PR or during implementation:

- **Q.** Does fbDOOM's vendored `d_net.c` still expect the original `doomdata_t` packet layout, or has the maximevince fork drifted? If drifted, the chocolate-doom-style `i_net_posix.c` may need tweaks.
  **Provisional A.** Spot-check the fork on first patch-apply; document delta in the patch comment.
- **Q.** What's `sys_recvfrom`'s behaviour for blocking DGRAM sockets today?
  **A.** `crates/kernel/src/syscalls.rs:6133-6134` unconditionally returns `EAGAIN` on an empty queue — the socket's `O_NONBLOCK` flag is *not* consulted. So all DGRAM sockets are effectively always-nonblocking in this kernel. **DOOM's `i_net_posix.c` uses `select` + nonblocking polling, so this works for DOOM in practice.** A proper fix (consult `O_NONBLOCK`, otherwise block via the existing wait machinery) is filed as a follow-up (§10) and tracked in `docs/posix-status.md`. We do not fix it in this PR — it's a kernel-correctness issue independent of the relay work.
- **Q.** Should the "Host" peer also run a small local matchmaking helper (e.g. a shareable room code) so we don't have to copy-paste SDPs forever?
  **Provisional A.** No — that is the "real signaling server" follow-up already in the upstream WebRTC plan. Keep manual SDP here for symmetry.
- **Q.** Wire-format compatibility with stock Chocolate Doom — yes/no?
  **Provisional A.** No (explicit non-goal in §1). Internal consistency only. Revisit after we have a working in-tree pairing.

## §10. What this unlocks

**Immediately:**
- First real BSD-sockets workload exercised over WebRTC end-to-end. The numbers it produces (RTT, packet loss, tic budget headroom) are reusable for any future game/network port.
- First non-loopback `SOCK_DGRAM` user of the kernel's `sys_sendto`/`sys_recvfrom`. Real workload coverage that the unit-test loopback can't give.

**Downstream (separate design+plan PRs, in roughly dependency order):**
- **Tic-level RTT + packet-loss telemetry** — surface the numbers v1 deliberately omits. Requires a cross-Wasm-boundary stats channel (new syscall, magic stdout protocol, or shared memory window). Its own design.
- **POSIX-compliant blocking `recvfrom` for DGRAM** — fix `crates/kernel/src/syscalls.rs:6133-6134`'s unconditional `EAGAIN` so blocking-mode DGRAM sockets actually block. Independent kernel-correctness fix; bumps `ABI_VERSION` only if it changes the host-call surface (it shouldn't).
- **Reset-during-game UX** — v1 hides/disables the Reset button while a game is running (cheapest fix). The proper version is two pages (signaling page → game page) with the open channel handed off; this needs a runtime channel registry.
- **Real signaling server** — `PUT/GET /signaling/<roomId>/{offer,answer}`. Replaces manual paste. Same code unlocks the chat demo too.
- **TURN** — if cross-country trials surface symmetric NATs. Likely self-hosted `coturn`.
- **Mesh DataChannels (3–4 peers)** — `RelayChannel` learns a peer table keyed on synthetic IP; one channel per pair; DOOM tolerates this natively (it's how 4-player IPX worked).
- **TCP over WebRTC** — analogous to this design but `ordered:true, maxRetransmits:undefined`. Unlocks SSH, Erlang distribution, MariaDB replication, ... a much larger surface.
- **Cross-port interop** — drop fbDOOM's wire format and adopt Chocolate Doom's. Lets browser-fbDOOM play against native chocolate-doom over a WebRTC↔UDP gateway.
- **Stock chocolate-doom build** — would also need SDL2 (currently absent from the SDK). Out of scope here.

Each of those is its own design+plan PR pair, with this one as the prerequisite.
