# Multiplayer DOOM over WebRTC DataChannel — Implementation Plan

Date: 2026-05-19
Branch: `explore-webrtc-doom-xl7dh`
Companion design: [`2026-05-19-multiplayer-doom-webrtc-design.md`](./2026-05-19-multiplayer-doom-webrtc-design.md)

> **Goal:** Two browsers on different machines play a deathmatch of fbDOOM. The byte path is an unreliable+unordered `RTCDataChannel`; fbDOOM's chocolate-doom-shaped `d_net.c` is driven by a new POSIX BSD-sockets `i_net_posix.c`; the cross-thread glue is a two-half relay (`RelayChannel` on the page main thread, `RelayHostShim` on the kernel-worker) bridged via a new `kernel_inject_datagram` export and a new `HostIO::send_dgram` host call.
>
> **ABI: no version bump expected.** Per `docs/abi-versioning.md` (after PR #490), adding a new kernel-wasm export while leaving existing exports unchanged is **additive** — `abi/snapshot.json` is regenerated, but `ABI_VERSION` does not bump. Kernel-wasm imports are not tracked in the snapshot at all, so the new `host_send_dgram` import is invisible to the check. The `HostIO::send_dgram` trait method is internal Rust API, also not snapshotted. Net: regenerate the snapshot, expect a single additive line for the new export, run `scripts/check-abi-version.sh` — no `ABI_VERSION` edit. Bump only if the verification surfaces a non-additive structural change we didn't anticipate.

## Tech stack

- Rust (kernel) — new `HostIO::send_dgram` trait method in `crates/kernel/src/process.rs`, new `kernel_inject_datagram` export in `wasm_api.rs`, `sys_sendto` dispatches to the new host hook for non-loopback destinations. `sys_recvfrom` unchanged (its existing `dgram_queue` is the inbound landing pad).
- TypeScript (host + browser demo page) — no new npm dependencies. New main-thread `RelayChannel` module in `apps/browser-demos/lib/` (sibling of `connection-pump.ts`, which is the existing cross-thread bridge that also does not implement `NetworkIO`); new kernel-worker-side `RelayHostShim` wired alongside `TlsNetworkBackend` in `host/src/browser-kernel-worker-entry.ts`.
- C (the fbDOOM patch) — uses only POSIX libc (`socket`, `bind`, `sendto`, `recvfrom`, `select`, `setsockopt`). Lifted from chocolate-doom's `net_sdl.c`/`net_loop.c`.
- The existing `wasm32posix-cc` SDK toolchain (worktree-local, via `sdk/activate.sh`).
- Browser-native `RTCPeerConnection` / `RTCDataChannel`.
- Reuses existing `BrowserKernel`, `attachCanvas` framebuffer renderer, and lazy WAD-registration plumbing from `pages/doom/main.ts`.
- Reuses the freedoom1.wad fetch already wired into `packages/registry/fbdoom/build-fbdoom.sh`. **No new IWAD distribution.**

## Verification gauntlet

This change touches four subsystems:

1. **Kernel (Rust)** — new HostIO method, new kernel-wasm export, `sys_sendto` dispatch. Touches the snapshot (additive); no `ABI_VERSION` bump expected.
2. **Host runtime** (kernel-worker-side `RelayHostShim`, host-call dispatch in `host/src/kernel-worker.ts`).
3. **fbDOOM port** (new patch under `packages/registry/fbdoom/patches/`).
4. **Browser demo page + main-thread relay** (new `apps/browser-demos/pages/doom-mp/` + `apps/browser-demos/lib/relay-network-backend.ts`).

ABI snapshot regenerates (additive); `ABI_VERSION` does NOT bump. The applicable subset of the CLAUDE.md gauntlet (run in order):

```bash
# 1. Kernel unit tests — must remain green; test_udp_loopback in particular
#    still passes (loopback path is unchanged).
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib

# 2. Vitest (host) — must remain green; we add focused tests for the
#    main-thread RelayChannel's envelope framing (pure unit, fake
#    RTCDataChannel-like EventTarget; no live RTCPeerConnection).
cd host && npx vitest run

# 3. ABI snapshot — REGENERATE it; verify the diff is purely additive.
#    The new kernel_inject_datagram export is the only structural change;
#    the new host_send_dgram import is NOT tracked in the snapshot; the
#    new HostIO::send_dgram trait method is internal Rust API. Per
#    docs/abi-versioning.md (PR #490), a single added export with no
#    edits to existing exports is additive — NO ABI_VERSION bump.
bash scripts/check-abi-version.sh update   # writes new abi/snapshot.json
git diff abi/snapshot.json                 # inspect — expect +1 export only
bash scripts/check-abi-version.sh          # must pass with no version bump

# 4. Browser bundle builds.
cd apps/browser-demos && npx tsc --noEmit && npx vite build

# 5. fbDOOM still builds for wasm32 with the new patch applied.
bash packages/registry/fbdoom/build-fbdoom.sh
```

**Suites 3 and 4 of the global gauntlet (libc-test, posix-tests) do not apply** — the user-space POSIX surface is unchanged (`sys_sendto`/`sys_recvfrom` syscall numbers and signatures are the same; only the internal dispatch grows a non-loopback branch).

**The actual verification is the manual two-machine smoke test from §7 of the design.** This is non-negotiable per CLAUDE.md's *"When fixing browser demo bugs, run `./run.sh browser` and manually verify the fix in a browser before claiming it works."* — extended to: do not claim done without two machines actually playing a round of DOOM.

## Single PR, single branch

This whole plan ships as **one PR** on the existing branch `explore-webrtc-doom-xl7dh`, stacked on the chat-demo work that already lives here. Each task below is one commit, conventional-commits style (`feat(net): …`, `feat(fbdoom): …`, `feat(browser): …`, `docs: …`). The PR does not merge until the two-machine smoke test (Task 6) passes and the user explicitly confirms.

---

## Task 1 — Kernel: `kernel_inject_datagram` export + `HostIO::send_dgram`

**Goal.** Add the kernel-side surface needed to route UDP datagrams between fbDOOM (running in a process-worker) and the page main thread (where `RTCDataChannel` lives), in both directions. The single new kernel-wasm export plus the regenerated `abi/snapshot.json` go in one focused commit.

**Files** (line numbers verified against rebased main on 2026-05-19)

- Modify: `crates/kernel/src/process.rs` — at the `HostIO` trait body (`pub trait HostIO` at L25; `host_net_*` methods at L96-113), add:
  ```rust
  fn send_dgram(
      &mut self,
      src_port: u16,
      dst_ip: [u8; 4],
      dst_port: u16,
      data: &[u8],
  ) -> Result<usize, Errno> {
      Err(Errno::ENETUNREACH)
  }
  ```
  The default impl returning `ENETUNREACH` means every existing concrete impl (`WasmHostIO` in `wasm_api.rs:169` + the in-test mocks in `syscalls.rs`) compiles unchanged; only `WasmHostIO` overrides it. Signature has no per-socket "handle" param — the relay is per-channel, not per-socket; the kernel passes the bound `src_port` so the host can populate the wire envelope.
- Modify: `crates/kernel/src/syscalls.rs` — at L6066-6068 (`sys_sendto`'s `ENETUNREACH` branch for non-loopback, inside `sys_sendto` defined at L6023), replace with a call into `host.send_dgram(src_port, dst_ip, dst_port, buf)`. The existing loopback branch at L6074-6097 is unchanged, so `test_udp_loopback` (L15441) continues to pass. Add a unit test that exercises the non-loopback branch with a mock `HostIO` (override `send_dgram` on `NetMock` or a new mock).
- Modify: `crates/kernel/src/wasm_api.rs`:
  - In the `extern "C"` host-imports block at L38, add `fn host_send_dgram(src_port: u32, dst_a: u32, dst_b: u32, dst_c: u32, dst_d: u32, dst_port: u32, data_ptr: *const u8, data_len: u32) -> i32;` (mirror the parameter-shape of `host_net_listen` at L100-107).
  - On `impl HostIO for WasmHostIO` (L169), override `send_dgram` to call the new host import (mirror `host_net_listen`'s wrapper at L630-642).
  - Add the new `kernel_inject_datagram` export next to `kernel_inject_connection` at L9219, with signature:
    ```rust
    #[unsafe(no_mangle)]
    pub extern "C" fn kernel_inject_datagram(
        pid: u32,
        dst_port: u32,
        src_a: u32, src_b: u32, src_c: u32, src_d: u32,
        src_port: u32,
        data_ptr: *const u8, data_len: u32,
    ) -> i32 { ... }
    ```
    Body: look up `proc` via `pid`; linearly scan `proc.sockets` for a `SocketType::Dgram` in `Bound`/`Connected` state with `bind_port == dst_port` (mirroring `sys_sendto`'s loopback scan at L6074-6088); push `Datagram { data: data.to_vec(), src_addr: [src_a, src_b, src_c, src_d], src_port: src_port as u16 }` onto its `dgram_queue` (mirroring the FIFO push at L6090-6097); wake any `sys_recvfrom` blocked on that socket via the kernel's existing wakeup machinery. Returns `0` on success, negative errno on failure (`-ESRCH` no such pid, `-ECONNREFUSED` no bound socket on that port).
- Regenerate: `abi/snapshot.json` via `scripts/check-abi-version.sh update`. **Expected drift:** +1 entry in `kernel_exports` (`kernel_inject_datagram`). Kernel-wasm imports are not tracked in the snapshot, so the new `host_send_dgram` import is invisible to the check. Anything else in the diff is a surprise — investigate before committing.
- **NO edit** to `crates/shared/src/lib.rs`. `ABI_VERSION` stays at its current value (11 on main as of rebase). Per `docs/abi-versioning.md`'s additive policy (PR #490), adding a single new kernel-wasm export with no edits to existing exports is backward-compatible and does NOT require a version bump.

**Why `(pid, dst_port)`, not `(pid, fd)`.** The TCP analogue `kernel_inject_connection` takes a `listener_fd`, which works because `sys_listen` notifies the host of the (pid, fd, port) tuple via `host_net_listen` (`syscalls.rs:5670`). `sys_bind` (`syscalls.rs:5534`) has no analogous DGRAM notification, so an fd-based inject would require a *third* new HostIO hook just to teach the host fbDOOM's UDP fd. Port-based addressing sidesteps this — the page already knows the port (5029, baked into the `-server`/`-connect` flag) and the pid (it spawned fbDOOM). The kernel's per-process linear scan is the same one `sys_sendto`'s loopback branch already uses.

**No `sys_recvfrom` change.** Once datagrams land in `dgram_queue` via the new injection path, the existing `sys_recvfrom` drain logic (function at L6105) already does the right thing. (The unconditional-EAGAIN bug at L6133-6134 is documented in the design's §9 and filed as a follow-up; it doesn't block DOOM because DOOM polls.)

**Verification**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
bash scripts/check-abi-version.sh   # passes; snapshot drift is additive,
                                    # no ABI_VERSION bump needed
```

This task lands as a single commit: `feat(kernel): UDP host-side relay hooks`. The new export + trait method + import + WasmHostIO wrapper + snapshot regeneration all go in one commit. If the additive check somehow fails (unexpected non-additive drift), pause and surface — do not blindly bump.

---

## Task 2 — Two-half relay backend

**Goal.** The main-thread `RelayChannel` (owns `RTCDataChannel`, calls `kernel.injectDatagram`, listens for `host-send-dgram` messages) plus the kernel-worker-side `RelayHostShim` (implements `HostIO::send_dgram` by `postMessage`-ing up to the main thread). Pure unit-testable: fake the channel with a paired in-memory `EventTarget` and exercise envelope framing without a browser.

**Files**

- New: `apps/browser-demos/lib/relay-network-backend.ts` — the main-thread `RelayChannel` class (~150 LOC). Sibling of `connection-pump.ts` (the existing cross-thread bridge that also is not a `NetworkIO` impl). See design §5.1 + §5.3 for the wire envelope.
- Modify: `host/src/browser-kernel-host.ts` (near the existing `injectConnection` at L603-618) — expose `injectDatagram(pid, dstPort, srcIp, srcPort, data): void`. **This is synchronous fire-and-forget — no `requestId`, no awaited Promise, returns `void`.** Unlike `injectConnection` which routes via `this.request(...)`, `injectDatagram` posts a one-way `{ type: "inject_datagram", pid, dstPort, srcIp, srcPort, data }` message to the kernel-worker via `sendToKernel(...)` (the existing fire-and-forget channel used by `pipeCloseWrite`, `wakeBlockedReaders`, etc., at L644-671). Rationale in design §5.1: at DOOM's ~35 Hz cadence we cannot afford a Promise + thread round-trip per packet, and there is no return value worth consuming (a drop is a drop). Also add a registration API (e.g. `kernel.onHostSendDgram(handler)`) that the `RelayChannel` uses to subscribe to outbound datagrams forwarded from the kernel-worker.
- Modify: `host/src/browser-kernel-worker-entry.ts` — near the existing `TlsNetworkBackend` instantiation at L339, add the `RelayHostShim` wiring. Receive the choice "this kernel needs UDP relay" via the init message; instantiate the shim; route its outbound messages to the main thread via `self.postMessage`.
- New: `apps/browser-demos/test/relay-network-backend.test.ts` (or equivalent location matching existing browser-side test conventions) — vitest:
  - Envelope encode/decode round-trip (header layout matches design §5.3).
  - Inbound `MessageEvent` triggers `kernel.injectDatagram` with the right args.
  - Outbound `host-send-dgram` message triggers exactly one `channel.send` call with a correctly-framed envelope.
  - Closing the channel cleans up listeners and stops dispatching.

**No live `RTCDataChannel` in vitest** — the channel is mocked with an `EventTarget` that has a `.send(data)` spy. The cross-thread `postMessage` path is mocked similarly.

**Verification**

```bash
cd host && npx vitest run relay-network-backend
cd apps/browser-demos && npx tsc --noEmit
```

---

## Task 3 — Kernel-worker UDP dispatch + `BrowserKernel` injection API

**Goal.** Wire the `RelayHostShim` so the kernel's new `HostIO::send_dgram` call actually goes somewhere useful, and expose `kernel.injectDatagram(...)` from `BrowserKernel` to the page main thread.

**Files**

- Modify: `host/src/kernel-worker.ts` — add a dispatcher that routes the kernel's `host_send_dgram` host call into the kernel-worker-side `RelayHostShim` (if one is registered) or returns `-ENETUNREACH` (preserving today's behaviour when no relay is present). The landmark to mirror is `onNetListen` at L1131. The design's first-draft references to L881/L4531 are now both off — find by symbol, not by line.
- Modify: `host/src/browser-kernel-host.ts` — proxy `injectDatagram(pid, dstPort, srcIp, srcPort, data)` from the page main thread through to the kernel-worker, which calls the kernel-wasm export. The wire-shape template is `sendToKernel(...)` at L644-671 (fire-and-forget), **not** `injectConnection` at L603-618 (request/response). Already specified in Task 2's bullet; Task 3 wires the kernel-worker dispatch side.
- Modify: `host/test/centralized-program.test.ts` (or sibling) — integration test that spins up a `RelayChannel` + `RelayHostShim` with paired in-memory `MessageChannel` legs, runs a small Wasm program that does `sendto`/`recvfrom` against `10.99.0.2:5029`, and asserts the bytes round-trip. **No live `RTCDataChannel`** — fake channel from Task 2's fixtures is reused.

**Browser parity.** Per CLAUDE.md (*"Every bug fix and feature must be considered for both hosts"*), this task touches the shared `kernel-worker.ts`. The Node host does NOT instantiate `RelayHostShim` (RTCDataChannel doesn't exist in Node); on the Node host, `sys_sendto` to a non-loopback dest falls through to the no-shim case and returns the existing `ENETUNREACH`. Audit step: grep for `RelayHostShim\|injectDatagram` in `host/src/` after the change to confirm no Node-host code path accidentally imports the browser-only relay module.

**Verification**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib   # green
cd host && npx vitest run                                              # green, new test passes
bash scripts/check-abi-version.sh                                      # additive snapshot from Task 1 still passes
```

---

## Task 4 — fbDOOM multiplayer patch (`0002-i_net-posix.patch`)

**Goal.** Replace fbDOOM's stub `i_net.c` with a chocolate-doom-style BSD-sockets driver and wire `-server` / `-connect` CLI flags into `d_main.c`.

**Files**

- New: `packages/registry/fbdoom/patches/0002-i_net-posix.patch` — see design §6. Contains:
  - `fbdoom/i_net.c` rewrite: ~400-600 LOC, POSIX sockets only — lifted from chocolate-doom's `net_sdl.c` + `net_loop.c` collapsed into one. (Design §6's revised estimate; the first-draft "~250 LOC" figure was wrong because fbDOOM's `d_net.c` is chocolate-doom-shaped, not vanilla id-shape, and needs the `InitConnectData`/`loop_interface_t` surface.)
  - `fbdoom/d_main.c` patch: `-server` and `-connect <ip>` argument parsing, sets `netgame=true; multiplayer=true; consoleplayer={0|1}; deathmatch={0|1|2}` from `-deathmatch` / `-altdeath`.
  - **No** changes to `i_video_fbdev.c`, `i_input_tty.c`, `r_*.c`, `p_*.c`. Rendering and input are unaffected.

- Modify: `packages/registry/fbdoom/build-fbdoom.sh` — no source changes; the existing patch loop (at L41-54) applies `0002-*.patch` automatically. The script does change one thing: after building, print the SHA256 of the resulting `fbdoom.wasm` so the binaries lockfile update is straightforward.

**Pre-flight investigation** (per design §9 Q1)

Before writing the patch, do three desk checks (each ~10-30 minutes):

1. **Confirm fbDOOM's `d_net.c` shape.** Verify that fbDOOM matches chocolate-doom's `loop_interface_t` / `D_RegisterLoopCallbacks` / `InitConnectData` interface. If the maximevince fork drifted, document the delta in the patch's leading comment block and adjust the new `i_net_posix.c` to match. Most common drift is in symbol names (`I_NetCmd` vs `I_NetSendData`).

2. **Verify `getaddrinfo` round-trips a literal IPv4.** Chocolate-doom's net code typically calls `getaddrinfo()` to fill in a `sockaddr_in` even when given a dotted-quad like `10.99.0.1`. Our `sys_getaddrinfo` (`crates/kernel/src/syscalls.rs:6007`) delegates to the host. If the host doesn't shortcut literal IPs (the browser host's bridge is HTTPS-shaped and may try a real DNS lookup), the `-connect 10.99.0.1` flow will fail at startup. Two acceptable outcomes: (a) the host does shortcut literals — verify and proceed; (b) it doesn't — patch `i_net_posix.c` to call `inet_aton`/`inet_pton` first and only fall back to `getaddrinfo` for non-literal hostnames. Chocolate-doom upstream already takes path (b), so this is mostly a copy-and-confirm.

3. **Check `setsockopt(SO_REUSEADDR)` behaviour.** Chocolate-doom sets `SO_REUSEADDR` on bind. If the kernel doesn't implement this `setsockopt` option (returns `ENOPROTOOPT`), the patch must `errno`-ignore rather than fail-fast — chocolate-doom itself ignores the return value, so the upstream behaviour is correct; we only need to confirm we're not crashing on it.

**Verification**

```bash
bash packages/registry/fbdoom/build-fbdoom.sh   # green, produces fbdoom.wasm
```

The build script's `install_local_binary` step puts the new wasm into `local-binaries/`, which has priority 1 in the resolver — so the page in Task 5 will pick it up automatically without rebuilding the release bundle.

---

## Task 5 — `pages/doom-mp/` demo page

**Goal.** A new browser page that does the signaling, wires the relay backend, spawns fbDOOM with the right CLI flags, and renders the canvas.

**Files**

- New: `apps/browser-demos/pages/doom-mp/index.html` — page shell. Layout:
  - Top: SDP textareas + handshake buttons (re-using the chat demo's structure). The **Reset** button is **hidden** (`display:none` via state class) once `state === "connected"` AND fbDOOM has been spawned — this is the v1 mitigation for "Reset-during-game kills the game" (review §E). Proper signaling/game decoupling is a follow-up.
  - Mid: a small panel with a Host/Join radio, a "Start DOOM" button (disabled until `connected`), and **one** live stat: WebRTC RTT (reusing the chat demo's 1 Hz ping-pong probe). Tic-level RTT and packet-loss are explicit follow-ups (design §10).
  - Bottom: the framebuffer canvas (same dimensions and focus model as `pages/doom/`).
- New: `apps/browser-demos/pages/doom-mp/main.ts` — composition: imports `setupSignaling()` (factored shared module from Task 5b below, if needed), `RelayChannel` (from Task 2), `BrowserKernel`, `attachCanvas`, and the `SCANCODE` map from `pages/doom/main.ts`.
- New: `apps/browser-demos/pages/doom-mp/doom-mp.css` — minor overrides on top of `lib/layout.css`.
- New: `apps/browser-demos/pages/doom-mp/README.md` — links to the chat demo's HTTPS-on-LAN setup, describes the user flow from design §7, notes which keys the player uses (Esc / arrows / Ctrl / Space — same as single-player), and adds one sharp-edge note: both peers must run this exact in-tree build and use the same IWAD (chocolate-doom's `InitConnectData` ships a WAD checksum; mismatches fail the netgame sync screen).
- Modify: `apps/browser-demos/vite.config.ts` — add the new page to `build.rollupOptions.input`.
- Modify: `apps/browser-demos/index.html` and each existing `pages/*/index.html` — add `<a href="/pages/doom-mp/">DOOM (multiplayer)</a>` to the sidebar, alphabetical-ish position next to the existing DOOM entry.

**Task 5b — factor signaling out of the chat demo (small, optional)**

The chat-demo's `main.ts` is currently self-contained. If after writing the doom-mp page we find we're duplicating > 80 LOC of handshake plumbing, lift the SDP-handshake state machine into `apps/browser-demos/lib/webrtc-signaling.ts` and import from both. **Only do this if the duplication is significant** — premature abstraction is explicitly worse than two clear files (per CLAUDE.md's general guidance). The chat demo continues to work either way.

**Verification**

```bash
cd apps/browser-demos && npx tsc --noEmit && npx vite build
./run.sh browser
# Browse to https://localhost:5198/pages/doom-mp/ (single-machine smoke)
```

- Page renders, sidebar entry navigates back and forth correctly.
- Handshake works between two tabs of the same browser (loopback DataChannel).
- Two tabs in the same browser can complete the netgame sync screen (this proves the relay + i_net_posix wiring; deathmatch with yourself is silly but functional).

Single-machine smoke is the gate for declaring Task 5 done. **Two-machine validation is Task 6.**

---

## Task 6 — Two-machine smoke test

**Goal.** The actual verification.

Run on two physical machines on the same WiFi (and, ideally as a stretch, repeat with one machine on a different network via Tailscale):

1. Generate HTTPS certs (per chat-demo README — mkcert or Tailscale) on both machines.
2. Start the dev server: `cd apps/browser-demos && VITE_HTTPS=1 npx vite --host`.
3. Machine A: open `https://<A-ip>/pages/doom-mp/`, pick **Host**, click **Create offer**.
4. Send SDP to machine B (Signal, Slack, whatever).
5. Machine B: open `https://<B-ip>/pages/doom-mp/`, pick **Join**, paste, click **Accept offer**.
6. Send B's SDP back; A clicks **Accept answer**.
7. Both click **Start DOOM**. Within ~10 s both reach E1M1 in deathmatch.
8. Verify: each player sees the other; firing across the room kills the other; quitting one side cleanly tears the other down.
9. WebRTC RTT readout reports under 50 ms on LAN. (Tic-level RTT and packet-loss are explicit follow-ups; v1 has no UI for them.)

Record results in the PR description (RTT, browsers used, machines used, any flakes).

---

## Task 7 — Documentation

**Goal.** Discoverability and accurate status.

**Files**

- Modify: `docs/architecture.md` — short subsection under networking: "WebRTC relay (`RelayChannel` + `RelayHostShim`)" — one paragraph, links to design doc, notes the `kernel_inject_datagram` export + `HostIO::send_dgram` host call.
- Modify: `docs/browser-support.md` — add the new demo to the demo list; note that `SOCK_DGRAM` now has a working browser-side path (was previously "kernel-side loopback only").
- Modify: `docs/posix-status.md` — flip whatever cell tracks UDP from "loopback only on browser" to "WebRTC peer-to-peer via RelayChannel" (with an asterisk on the WebRTC prerequisite). Also add a note: blocking-mode DGRAM `recvfrom` returns EAGAIN immediately regardless of `O_NONBLOCK` (known limitation; see follow-ups).
- Reference: `docs/abi-versioning.md` — no edits expected; the ABI bump in this PR follows the documented procedure. Cite the doc in the PR description.
- Modify: `README.md` — add one bullet under live demos pointing at `/pages/doom-mp/`.

Per CLAUDE.md: *"Every PR that adds or changes user-facing features, APIs, or behavior must include corresponding documentation updates."* This task is non-optional.

---

## Stop rules

- **Do NOT bump `ABI_VERSION` for this PR.** The expected snapshot drift (one new `kernel_inject_datagram` export, no edits to existing exports) is additive under `docs/abi-versioning.md`'s post-PR-#490 policy. The new `host_send_dgram` import isn't tracked in the snapshot. Regenerate `abi/snapshot.json` in Task 1's commit; if `scripts/check-abi-version.sh` reports a non-additive change anyway, **stop and surface** — that's an unexpected ABI break that needs reviewer attention, not a silent bump. Other kernel changes (e.g., fixing the unconditional-EAGAIN bug in `sys_recvfrom`) are explicit follow-ups, not in this PR.
- **Do not add a signaling server.** Manual SDP is the whole point of staying compatible with the chat demo's posture. The signaling-server work is a separate PR with its own design doc.
- **Do not pursue 3+ player support, audio, demos/replays, or anti-cheat in this PR.** All explicitly out of scope per design §1.
- **Do not switch to Chocolate Doom proper.** The SDL2 dependency is its own multi-week port. fbDOOM + patch is the right scope for this PR.
- **Do not add TURN.** TURN waits until cross-country trials surface symmetric NATs.
- **Do not add Playwright/CI tests for the WebRTC handshake or for an end-to-end DOOM game.** Same rationale as the chat demo's plan: two `RTCPeerConnection`s across two contexts is fragile in CI. Manual smoke is the verification path. Unit tests against the fake channel are fine.
- **Do not surface tic-level RTT or packet-loss in the UI.** They have no plumbing path in v1; building one requires a new cross-Wasm-boundary stats channel. Follow-up.

## Out-of-scope follow-ups (separate plan PRs)

In rough dependency order:

- **Tic-level RTT + packet-loss telemetry** — cross-Wasm-boundary stats channel (new syscall, magic stdout protocol, or shared memory window). The status panel gets two more numbers once this lands.
- **POSIX-compliant blocking `recvfrom` for DGRAM** — fix `crates/kernel/src/syscalls.rs:5279`'s unconditional `EAGAIN` so blocking-mode DGRAM sockets actually block. Independent kernel-correctness fix.
- **Reset-during-game UX** — v1 hides the Reset button while a game is running. The proper version is two pages (signaling page → game page) with the open channel handed off via a runtime channel registry.
- **Real signaling server** (`PUT/GET /signaling/<roomId>/{offer,answer}`). Drops the copy-paste step for both the chat demo and doom-mp.
- **3–4 player mesh.** `RelayChannel` learns a peer table; one DataChannel per pair; DOOM is already happy with this topology.
- **TURN relay** if cross-country trials need it.
- **Cross-port wire-format interop** so browser-fbDOOM can play stock chocolate-doom over a small native↔WebRTC gateway.
- **Relay path for TCP** — ordered+reliable variant of `RelayChannel`. Unlocks SSH, Erlang dist, MariaDB replication.
- **ACL layer** — per-peer port allowlist; without it a paired peer can `sendto` anywhere your kernel is listening. Important even at home.
- **Real signaling for DOOM matchmaking** — room codes, lobby UI, in-game chat. Separate from the generic signaling server.

Each is its own design + plan PR pair.
