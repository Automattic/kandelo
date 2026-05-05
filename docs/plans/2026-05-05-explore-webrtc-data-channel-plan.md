# WebRTC DataChannel Manual SDP — Implementation Plan

Date: 2026-05-05
Branch: `explore-webrtc-data-channel-plan`
Companion design: [`2026-05-05-explore-webrtc-data-channel-design.md`](./2026-05-05-explore-webrtc-data-channel-design.md)

> **Goal:** A standalone browser demo (`examples/browser/pages/webrtc-test/`) that connects two `RTCPeerConnection`s across two browser instances on a LAN via manual SDP copy-paste, opens an `RTCDataChannel`, and supports bidirectional text chat. Surfaces the candidate-pair type and round-trip latency. No kernel involvement.

## Tech stack

- Plain HTML + TypeScript module (`<script type="module" src="./main.ts">`), bundled by the existing Vite config in `examples/browser/`
- Browser-native `RTCPeerConnection` / `RTCDataChannel` — no `simple-peer`, no `peerjs`, no other dependency
- Existing `examples/browser/lib/layout.css` for sidebar + page chrome
- No kernel imports (`@kernel-wasm`, `BrowserKernel`, `MemoryFileSystem` — none of these are touched)
- No new npm packages

## Verification gauntlet

Browser-only feature, no Wasm/kernel surface area changed. CLAUDE.md's full gauntlet (`cargo test`, `libc-test`, `posix-tests`, ABI snapshot) is **not** applicable here. The relevant subset is:

```bash
# Type-check the new module
cd examples/browser && npx tsc --noEmit

# Existing host integration tests must still pass (sanity)
cd host && npx vitest run

# Build the browser bundle (catches Vite-config regressions)
cd examples/browser && npx vite build
```

Plus the **manual two-browser smoke test** from §4 of the design — this is the only test that actually exercises the page.

The browser demo verification rule from CLAUDE.md applies: *"When fixing browser demo bugs, run `./run.sh browser` and manually verify the fix in a browser before claiming it works."* This plan extends that to a new demo: do not claim done without running the page in two browser contexts.

## Single PR, single branch

This whole plan ships as **one PR** on branch `explore-webrtc-data-channel-plan`, stacked on `explore-webrtc-data-channel-design`. Each task below is one commit. The PR does not merge until manual two-browser verification (Task 4) passes and the user explicitly confirms.

---

## Task 1 — Page scaffolding (no logic yet)

**Goal.** Empty page renders at `/pages/webrtc-test/`, sidebar shows the new entry, no console errors.

**Files**

- New: `examples/browser/pages/webrtc-test/index.html`
- New: `examples/browser/pages/webrtc-test/main.ts` (empty stub: `console.log("[webrtc-test] loaded")`)
- Modify: `examples/browser/vite.config.ts` — add `"webrtc-test": path.resolve(__dirname, "pages/webrtc-test/index.html")` to `build.rollupOptions.input`
- Modify: `examples/browser/index.html` and every existing `examples/browser/pages/*/index.html` — add `<a href="/pages/webrtc-test/">WebRTC test</a>` to the sidebar nav, in alphabetical-ish position consistent with the others

**Page structure** (`pages/webrtc-test/index.html`):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WebRTC DataChannel — wasm-posix-kernel</title>
  <link rel="stylesheet" href="../../lib/layout.css" />
</head>
<body>
  <nav class="sidebar"><!-- same shape as siblings, "WebRTC test" aria-current --></nav>
  <div class="main">
    <div class="main-header">
      <h1>WebRTC DataChannel (manual SDP)</h1>
      <p class="subtitle">Two browser instances on a LAN, peer-to-peer chat, no kernel.</p>
    </div>
    <div class="preview-area">
      <section class="instructions"><!-- §4 of design, verbatim --></section>
      <section class="handshake">
        <div class="sdp-pane">
          <label>Local SDP <button id="copy-local">Copy</button></label>
          <textarea id="local-sdp" readonly></textarea>
        </div>
        <div class="sdp-pane">
          <label>Remote SDP</label>
          <textarea id="remote-sdp"></textarea>
        </div>
      </section>
      <section class="controls">
        <button id="create-offer">Create offer</button>
        <button id="accept-offer" disabled>Accept offer</button>
        <button id="accept-answer" disabled>Accept answer</button>
        <button id="reset" disabled>Reset</button>
      </section>
      <section class="status"><pre id="status"></pre></section>
      <section class="chat">
        <div id="log"></div>
        <form id="send-form"><input id="msg" disabled placeholder="Connect first…" /><button disabled>Send</button></form>
      </section>
    </div>
  </div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

**Verification**

```bash
./run.sh browser
# Browse to http://localhost:5198/pages/webrtc-test/
```

- Page renders with sidebar, instructions, two textareas, three buttons, log area
- Browser console shows `[webrtc-test] loaded` and no errors
- Sidebar entry on every other demo page links here and back

---

## Task 2 — RTC handshake (logic only, no UI hookup yet)

**Goal.** Pure functions in `main.ts` that drive the RTCPeerConnection lifecycle. Verified by exporting them onto `window` and driving them from the dev console in two tabs.

**Files**

- Modify: `examples/browser/pages/webrtc-test/main.ts`

**Functions to implement**

```ts
// Module-level singleton
let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function setupPC(): RTCPeerConnection { /* new pc, wire onconnectionstatechange / oniceconnectionstatechange / onicegatheringstatechange / ondatachannel */ }

function gatheringComplete(pc: RTCPeerConnection): Promise<void> {
  return new Promise(resolve => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.addEventListener("icegatheringstatechange", function check() {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    });
  });
}

async function createOffer(): Promise<string> {
  pc = setupPC();
  dc = pc.createDataChannel("kandelo");
  wireDataChannel(dc);
  await pc.setLocalDescription(await pc.createOffer());
  await gatheringComplete(pc);
  return JSON.stringify(pc.localDescription);
}

async function acceptOffer(remoteSdp: string): Promise<string> {
  pc = setupPC();
  // dc arrives via pc.ondatachannel
  await pc.setRemoteDescription(JSON.parse(remoteSdp));
  await pc.setLocalDescription(await pc.createAnswer());
  await gatheringComplete(pc);
  return JSON.stringify(pc.localDescription);
}

async function acceptAnswer(remoteSdp: string): Promise<void> {
  if (!pc) throw new Error("no offer to accept answer for");
  await pc.setRemoteDescription(JSON.parse(remoteSdp));
}

function wireDataChannel(channel: RTCDataChannel) { /* onopen → enable chat, onmessage → append to log, onclose → tear down */ }

function reset() { /* dc?.close(); pc?.close(); pc = dc = null; clear textareas, reset button states */ }

// Expose for ad-hoc testing in Task 2; UI hookup in Task 3
(window as any).rtc = { createOffer, acceptOffer, acceptAnswer, reset, get pc() { return pc; }, get dc() { return dc; } };
```

**Detail to get right**

- `gatheringComplete` is the load-bearing piece. Manual copy-paste requires non-trickle ICE: the SDP must include all candidates *before* it's exposed to the user. If you skip the wait, the pasted SDP is missing candidates and the connection never establishes.
- Resolve `gatheringComplete` if state is already `"complete"` synchronously — Chrome occasionally fires the state change before the listener attaches.
- `JSON.stringify(pc.localDescription)` — capture the whole `RTCSessionDescriptionInit` (`type` and `sdp`), not just the SDP string. Pasting back uses `JSON.parse`.

**Verification**

Open `/pages/webrtc-test/` in two tabs of the same browser. In tab A's console:
```js
await rtc.createOffer()    // → JSON SDP
```
Copy the result, in tab B's console:
```js
await rtc.acceptOffer(`<paste>`)   // → JSON SDP
```
Copy, in tab A:
```js
await rtc.acceptAnswer(`<paste>`)
rtc.dc.send("hello")
```
Tab B logs `hello` via `dc.onmessage`. Both `pc.connectionState` go to `"connected"`.

---

## Task 3 — UI binding & state machine

**Goal.** Buttons and textareas drive the handshake; user never opens the dev console.

**Files**

- Modify: `examples/browser/pages/webrtc-test/main.ts`

**State machine**

```
   idle
     │ click "Create offer" (offerer path)         │ paste remote, click "Accept offer" (answerer path)
     ▼                                             ▼
   awaiting-answer                               connecting
     │ paste remote, click "Accept answer"         │ (no further user action)
     ▼                                             ▼
   connecting                                    connected
     │                                             │
     └──── pc.connectionState === "connected" ──── ▼
                                                connected
                                                  │ click "Reset"
                                                  ▼
                                                idle
```

Button-enabled matrix:

| State | Create offer | Accept offer | Accept answer | Reset | Chat input |
|-------|--------------|--------------|---------------|-------|------------|
| idle | ✓ | ✓ | — | — | — |
| awaiting-answer | — | — | ✓ | ✓ | — |
| connecting | — | — | — | ✓ | — |
| connected | — | — | — | ✓ | ✓ |
| failed | — | — | — | ✓ | — |

**Status panel**

Render `pc.connectionState`, `pc.iceConnectionState`, `pc.iceGatheringState` live, plus once `connected`:
- Active candidate-pair type via `pc.getStats()` (`type === "candidate-pair" && nominated`) → look up the local/remote candidates → render their `candidateType` (`host`, `srflx`, `prflx`, `relay`)
- 1 Hz ping/pong over the DataChannel: peer A sends `{"t":"ping","ts":<ms>}`; peer B replies `{"t":"pong","ts":<echoed>}`; A computes RTT; both peers display their last seen RTT

**Verification**

Same two-tab smoke test as Task 2, but driven entirely from the page UI. State transitions correct, buttons disabled when not applicable, status panel populates.

---

## Task 4 — HTTPS-on-LAN opt-in & manual two-browser test

**Goal.** Make it possible (without changing defaults) for the user to serve the dev server over HTTPS so a second machine on the LAN can load the page in a secure context. Then perform the actual two-machine smoke test.

**Files**

- Modify: `examples/browser/vite.config.ts`
  - Add a small `https` block gated on `process.env.VITE_HTTPS === "1"`. Reads cert + key from `${HOME}/.local/share/wasm-posix-kernel/certs/{cert.pem,key.pem}` (mkcert default-friendly path; documented). If `VITE_HTTPS=1` but the files are missing, fail the dev-server startup with a clear message that points to the README.
  - When `VITE_HTTPS` is unset, **no behavior change** — same defaults as today.
- New: `examples/browser/pages/webrtc-test/README.md`
  - One-page guide: secure-context requirement, mkcert recipe (5 lines), Tailscale recipe (3 lines), how to start the dev server with `VITE_HTTPS=1 npx vite --host`, troubleshooting (`SharedArrayBuffer is not defined` ⇒ not in secure context).

**Manual smoke test (the actual verification)**

Run on two physical machines on the same WiFi:

1. Generate a cert via mkcert (or use Tailscale) so the dev server can serve HTTPS.
2. Start the dev server: `cd examples/browser && VITE_HTTPS=1 npx vite --host`. Note both LAN URLs (`https://<lan-ip>:5198`).
3. Machine A: open `https://<machineA-lan-ip>:5198/pages/webrtc-test/`. Click **Create offer**.
4. Send the local SDP to machine B (Signal, Slack, anything plain-text).
5. Machine B: open the same URL on B's own LAN IP. Paste A's SDP, click **Accept offer**.
6. Send B's local SDP back to A.
7. Machine A: paste B's SDP, click **Accept answer**.
8. Both pages reach `connected`. Status panel shows `host ↔ host` candidate pair, RTT < 5 ms.
9. Send "hello" both ways. Click **Reset** on both. Repeat once to verify a clean re-handshake.

The user is expected to actually run this with their colleague before the PR merges. The PR description records the result.

---

## Task 5 — Documentation

**Goal.** Discoverability: someone new to the repo finds this demo from the README and `docs/browser-support.md`.

**Files**

- Modify: `README.md` — `Live demo` section / quick-start: add a one-line entry pointing at `/pages/webrtc-test/` after the existing demo bullets, framing it as "standalone WebRTC test, no kernel".
- Modify: `docs/browser-support.md` — short subsection in the demo table (or wherever the existing demo list lives) noting the page exists and that it's the prerequisite for future cross-instance work.

No documentation in `docs/architecture.md`, `docs/posix-status.md`, `docs/sdk-guide.md`, `docs/porting-guide.md` — none of those subsystems are touched.

**Verification**

Render the README locally (or read the markdown), confirm links resolve.

---

## Stop rules

These are explicit so no scope-creep happens during implementation:

- **Do not start integrating with the kernel.** No `RelayNetworkBackend`, no `host_net_*` plumbing, no `injectConnection` calls. That is the next PR after this lands.
- **Do not add a signaling server.** Manual paste is the whole point of this iteration.
- **Do not try to support trickle ICE.** Manual copy-paste fundamentally requires non-trickle.
- **Do not add Playwright tests for the WebRTC handshake.** Two `RTCPeerConnection`s across two contexts is fragile to test in CI; manual smoke-test is the verification path.
- **Do not refactor `examples/browser/lib/`** to make this page reuse anything from there. The page is intentionally standalone — no kernel imports, no shared state.
- **Do not edit `host/src/`, `crates/`, `glue/`, `sdk/`, or any build script outside of `examples/browser/`.**

## Out-of-scope follow-ups (separate plan PRs)

- `RelayNetworkBackend` — sibling of `FetchNetworkBackend` in `host/src/networking/`, wraps `RTCDataChannel` for kernel `host_net_*` outbound
- Inbound peer-connection pump — when peer X opens a connection to a port the local kernel is listening on, call `BrowserKernel.injectConnection(pid, fd, peerSyntheticIP, peerEphemeralPort)`. Parallel to `examples/browser/lib/connection-pump.ts`.
- Real signaling endpoint — `PUT /signaling/<roomId>/offer`, `GET /signaling/<roomId>/answer`. ~30 lines of any web framework.
- ACL layer — per-peer port allowlists; without this, a paired peer can `connect()` to anything the local kernel has listening, which is unsafe even at home.
- Unreliable+unordered DataChannel mode — for `SOCK_DGRAM`, in service of multiplayer Doom.
- TURN — only after we observe symmetric-NAT failures in the wild.

Each of those is its own design + plan PR pair, in roughly that order.
