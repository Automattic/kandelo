# WebRTC DataChannel Manual SDP — Design

Date: 2026-05-05
Branch: `explore-webrtc-data-channel-design`

## §1. Goals & non-goals

**Goal.** A standalone browser demo page (`examples/browser/pages/webrtc-test/`) that lets two browser instances on a LAN exchange typed messages over an `RTCDataChannel`. Signaling is manual: each peer copy-pastes the other's SDP into a textarea. The page does **not** use the kernel — it is a transport prerequisite.

**Why this exists.** The longer-term goal (separate plan) is a `RelayNetworkBackend` (sibling of `FetchNetworkBackend` in `host/src/networking/`) that lets two `wasm-posix-kernel` instances communicate over an `RTCDataChannel`. The byte path is peer-to-peer when NATs cooperate; when they don't (symmetric NAT, CGNAT — common across the public internet), the channel falls back to a TURN relay. The user's staged goals are LAN first, then two homes in different countries — the second of which likely needs TURN. See §5 for the NAT-traversal detail and §8 for how TURN fits the staged plan. Before any kernel integration, we need ground truth on three questions:

1. Does WebRTC actually connect between two physical machines on the user's home LAN?
2. Can the same HTTPS / cross-origin-isolation envelope satisfy *both* `SharedArrayBuffer` (for the kernel) *and* `RTCPeerConnection` (for WebRTC) simultaneously?
3. What is the round-trip latency of a raw DataChannel on this LAN, as a baseline for measuring kernel overhead later?

This page answers all three with the smallest possible amount of code and zero dependencies.

**Non-goals (v1).**

- No kernel integration. No `RelayNetworkBackend`. No `host_net_*` plumbing.
- No real signaling server. SDP is exchanged via copy-paste — chat app, email, Airdrop, anything the user picks.
- No multi-peer rooms. Exactly two peers; one DataChannel.
- No persistence. Reload kills the session.
- No TURN. Public STUN only (Google's `stun.l.google.com:19302`). Symmetric NATs will fail; that is acceptable for a LAN-first tool.
- No automated tests. Two `RTCPeerConnection` objects across two browser contexts is not robustly testable in Playwright/CI; manual smoke test is the verification path. (See §4.)
- No styling effort. Reuse `lib/layout.css`. Sidebar matches every other demo.
- No QR-coded SDP, no base64 framing of SDP, no compression. Raw JSON in textareas — debuggability beats compactness here.

**Constraint.** The Vite dev server already sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`examples/browser/vite.config.ts:283-287`). This makes every page on it cross-origin-isolated, which means **secure context** — the same prerequisite WebRTC has. The two requirements are compatible; we do not need to weaken anything.

**Success criteria.** Two laptops on the same WiFi load `https://<host>/pages/webrtc-test/`. Following the on-page instructions (§4), they paste two SDP blobs back and forth. The page reports "Connected" within ~5 seconds. Each peer types a message, the other peer sees it. The status panel shows the active candidate-pair type (`host` for direct LAN, `srflx` for STUN-mapped). Neither browser console contains an uncaught error.

## §2. Architecture

```
   Peer A (offerer)                          Peer B (answerer)
   ─────────────────                          ─────────────────
1. createDataChannel("kandelo")                 (no DC yet)
2. createOffer() → setLocalDescription
3. wait for iceGatheringState === "complete"
4. show pc.localDescription (offer SDP) ───►  paste into "Remote SDP" textarea
                                          5.  setRemoteDescription(offer)
                                          6.  createAnswer() → setLocalDescription
                                          7.  wait for iceGatheringState complete
                                          8.  show pc.localDescription (answer SDP)
   paste into "Remote SDP" textarea     ◄───
9. setRemoteDescription(answer)
                ICE candidates already in the SDPs (non-trickle)
                ICE pairs probe, succeed on host candidates (LAN) or srflx (NAT)
                                                ↓
                                pc.connectionState === "connected"
                                                ↓
                                A's dc.onopen fires       B's pc.ondatachannel fires
                                                ↓                       ↓
                                ──────────── DataChannel open ────────────
                                                ↓
                                Both sides: dc.send(string), dc.onmessage
```

**Three lifecycle states** drive the UI:

| State | What's enabled | What's shown |
|-------|----------------|--------------|
| Idle | "Create offer", "Accept offer" | Empty textareas, no chat |
| Negotiating | "Accept answer" if A; nothing if B (B is done after step 8) | Local SDP, "Waiting for…" status |
| Connected | Chat input | Status panel: candidate-pair type, RTT |

**Non-trickle ICE is deliberate.** Manual copy-paste fundamentally requires non-trickle: all ICE candidates must be embedded in the single SDP blob the user pastes, because there is no out-of-band channel to ship trickled candidates after the fact. The `iceGatheringState === "complete"` wait is what gives us that.

The downside is initial connection latency (we wait for STUN reflexive candidates to gather, ~1–3 s). Acceptable for a manual tool. Production / kernel-integration code will switch to trickle ICE over the real signaling channel.

**Both peers run the same page.** The only asymmetry is that A clicks "Create offer" first; B clicks "Accept offer" with A's blob; A clicks "Accept answer" with B's blob. The page's UI surfaces this as three buttons that the user clicks in sequence; nothing distinguishes A from B until the first click.

## §3. Where it lives

```
examples/browser/
├── pages/
│   └── webrtc-test/                      ← new
│       ├── index.html                    ← page shell, sidebar, controls, log
│       ├── main.ts                       ← all RTC logic, ~150 lines
│       └── README.md                     ← HTTPS-on-LAN setup notes (mkcert, Tailscale)
├── vite.config.ts                        ← +1 entry in rollupOptions.input
└── index.html                            ← +1 sidebar link (every page)
```

| File | Purpose |
|------|---------|
| `pages/webrtc-test/index.html` | Page shell. Reuses `lib/layout.css`. Two textareas (Local SDP, Remote SDP), three buttons (Create offer / Accept offer / Accept answer), status panel, chat input + log. |
| `pages/webrtc-test/main.ts` | All logic. Creates `RTCPeerConnection`, drives the handshake, wires DOM. No kernel imports, no `BrowserKernel`, no `MemoryFileSystem`. |
| `pages/webrtc-test/README.md` | Brief notes on enabling HTTPS for cross-machine LAN access (mkcert + `VITE_HTTPS=1`, or Tailscale's `tailscale serve`). |
| `vite.config.ts` | Add `"webrtc-test": path.resolve(__dirname, "pages/webrtc-test/index.html")` to `build.rollupOptions.input`. Optional: gate an `https` block behind `VITE_HTTPS=1` env var so the same dev-server can serve TLS without breaking existing single-machine workflows. |
| All `index.html` sidebars | Add `<a href="/pages/webrtc-test/">WebRTC test</a>` for navigability — same convention every other demo follows. |

**No kernel changes. No host-runtime changes. No new npm dependencies.**

## §4. The user flow (manual signaling)

This is how the page is used; the on-page instructions panel mirrors this verbatim.

Two participants — call them **A** (initiator) and **B** (responder). They pick which is which; the role is decided by who clicks first.

1. Both load the page on their respective machines.
2. **A** clicks **Create offer**. After ~1–3 s of ICE gathering, A's local SDP appears in the "Local SDP" textarea.
3. A copies the local SDP and sends it to B over any out-of-band channel (chat, email, Signal, dictation — it's plain text).
4. **B** pastes A's SDP into the "Remote SDP" textarea, clicks **Accept offer**. After ~1–3 s of ICE gathering, B's local SDP (the *answer*) appears in their "Local SDP" textarea.
5. B sends their SDP back to A.
6. **A** pastes B's SDP into the "Remote SDP" textarea, clicks **Accept answer**.
7. The DataChannel opens on both sides. The chat input becomes active. Each typed line crosses peer-to-peer, with no server in the byte path.

If the connection times out (say, 30 s after "Accept answer"), the page surfaces the failure with whatever state ICE got stuck in (`failed`, `disconnected`) and tells the user to retry.

## §5. STUN / NAT / LAN behavior

**On a LAN**, both peers gather `host` candidates — their actual LAN IPs (or mDNS-obfuscated `<uuid>.local` hostnames in Chrome). ICE pairs the two `host` candidates and they connect directly. STUN is configured but unused.

**Across the internet**, `host` candidates fail. ICE then probes `srflx` (server-reflexive — the IP/port the STUN server saw the peer connecting from). Direct peer-to-peer succeeds for full-cone or restricted-cone NATs — most home routers. Symmetric NATs (some corporate networks, CGNAT) cannot establish direct P2P without TURN, which v1 does not ship.

**The page surfaces the active candidate-pair** after `connectionState === "connected"`, so the user can see *how* they connected:

```
Connected via host ↔ host       (direct LAN — best)
Connected via srflx ↔ srflx     (P2P over the internet — good)
                                 (relay — would mean TURN, not configured here)
```

## §6. HTTPS on LAN — what the user must arrange

Browsers grant secure-context status to:

- `localhost` and `127.0.0.1` over plain HTTP (single-machine only)
- Any origin over HTTPS

Cross-machine LAN access (`http://192.168.1.42:5198`) is **not** a secure context, so neither `SharedArrayBuffer` nor `RTCPeerConnection` is available there. The user must arrange HTTPS to reach the page from a second machine.

This page does not solve HTTPS-on-LAN — it documents the requirement. The README points to two known-good paths:

1. **`mkcert`** — generates a locally-trusted CA and per-host cert. Plug it into Vite via a `server.https` block gated on `VITE_HTTPS=1`.
2. **Tailscale** — install on both machines; access via `https://<host>.<tailnet>.ts.net`. Tailscale provisions the TLS cert itself. This is also the easiest path to "and the same setup works when one of us is on the train."

A `VITE_HTTPS=1` environment variable will opt into HTTPS in the dev server, loading certs from a documented path. When the variable is unset (the default), the dev server behavior is unchanged — preserving the single-machine workflow for everyone else.

## §7. Open questions

To settle in the plan PR or during implementation:

- **Q.** Should the chat use `dc.send` for raw strings, or wrap in a small framing protocol now (length-prefixed, JSON envelopes) since we know `RelayNetworkBackend` will need framing?
  **Provisional A.** Raw strings now. Framing belongs to the `RelayNetworkBackend` plan, not this prerequisite.
- **Q.** Should we ping every second after connection to surface RTT in the status panel?
  **Provisional A.** Yes — single ping/pong loop, 1 s interval. Cheap, gives the user a useful number.
- **Q.** Should we offer a **reset** button that tears down the `RTCPeerConnection` and starts a fresh handshake?
  **Provisional A.** Yes. Without it, debugging a botched handshake means hard-reloading.
- **Q.** Should we support dragging an SDP file in, in addition to pasting into the textarea?
  **Provisional A.** No. Out of scope for v1.

## §8. What this unlocks

The user's actual goal is staged: **LAN first** (validate the WebRTC handshake at all, on real hardware, with the same browsers and the same cross-origin-isolation setup that the kernel needs), then **two homes in different countries**. This v1 page covers stage one; stage two needs additional infrastructure — most importantly a TURN relay if either NAT is symmetric.

Stage one (LAN) — once this page works between two laptops on the user's WiFi:

- **Confirmed LAN handshake.** WebRTC's offer/answer/candidate flow runs successfully between two physical browsers. Direct `host`-candidate pairing — no STUN, no TURN.
- **Confirmed cross-origin-isolation compatibility.** The same `COOP`/`COEP` envelope that the kernel needs also works for `RTCPeerConnection`. No subtle interaction blows up.
- **Performance baseline.** The DataChannel ping shows the bare-network RTT. Future kernel-integration work can compare against this number to size the kernel overhead.
- **Mental model anchored.** The user has hands-on familiarity with the offer/answer/candidate dance before reading any of `RelayNetworkBackend`'s code.

Stage two (cross-country) — explicitly **not** validated by this v1 page, since both peers are on the same LAN. A separate follow-up will:

- Test the same page across two different home networks (one peer at home, one peer on a hotspot or remote location). This stresses STUN-mapped `srflx` candidates and may surface symmetric-NAT failures.
- Add TURN (likely a self-hosted [coturn](https://github.com/coturn/coturn), or a managed service) to provide a working fallback when direct P2P fails. This is a **byte-path relay**, distinct from a signaling server, and is needed even when the rest of the architecture stays peer-to-peer.

The follow-up work — explicitly out of scope for this design, listed roughly in dependency order:

- **Cross-network validation** — same v1 page, two peers on different networks (no kernel changes needed; just retry the smoke test from elsewhere). First evidence of whether the user's NAT pair needs TURN.
- **TURN relay** — required if cross-network validation surfaces symmetric-NAT failure. Self-host coturn on a small VPS, or use a managed service. Even then, the byte path stays direct on the happy path; TURN only kicks in as a fallback.
- **A real signaling server** — HTTP `PUT`/`GET` for offer/answer blobs keyed by room-id; ~30 lines of any web framework. Replaces manual copy-paste.
- **`RelayNetworkBackend`** — sibling of `FetchNetworkBackend` in `host/src/networking/`, wraps an `RTCDataChannel` for kernel `host_net_*` outbound. This is the first kernel-touching follow-up.
- **Inbound peer-connection pump** — parallel to `examples/browser/lib/connection-pump.ts`; calls `injectConnection` when a peer opens a connection to a listening port.
- **ACL layer** — which peer can `connect()` to which port on which kernel. Non-optional even at home: without it, a paired peer can `connect()` to anything you happen to be running.
- **Unreliable+unordered DataChannel mode** — for `SOCK_DGRAM`, in service of multiplayer games (Doom).

Each of those is its own design+plan PR pair.
