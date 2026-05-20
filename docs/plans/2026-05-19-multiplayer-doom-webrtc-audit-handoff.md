# Multiplayer DOOM over WebRTC — Audit-Pass Handoff

Date: 2026-05-19 (same day as sessions 1–3)
Branch: `explore-webrtc-doom-xl7dh` (clean tree, no new commits this session)
User: mho22 / yannick@capsules.codes — Brandon Payton style.

> **POST-REBASE NOTE (added 2026-05-19, session 5):** The "Verified citations"
> section below was authored against the pre-rebase tree. After the branch
> was rebased onto `origin/main`:
> - `examples/browser/*` was reorganized to `apps/browser-demos/*` (PR #492).
> - `examples/libs/fbdoom/*` was reorganized to `packages/registry/fbdoom/*`.
> - `host/src/networking/tls-network-backend.ts` now exists in `host/src/`
>   (was `examples/browser/lib/tls-network-backend.ts`).
> - Most kernel-source line numbers shifted by hundreds of lines.
> - `ABI_VERSION` is **11** on main (was 7 pre-rebase). The "bump 7→8" plan
>   is doubly stale: the value is wrong AND the additive-snapshot policy
>   landed via PR #490 means adding a single new kernel-wasm export is
>   backward-compatible and requires **no** `ABI_VERSION` bump at all.
>
> The refreshed citations live in `2026-05-19-multiplayer-doom-webrtc-plan.md`
> and `2026-05-19-multiplayer-doom-webrtc-design.md`, both updated in the
> same commit as this note. The "Findings — defects fixed in design.md"
> section below remains accurate (those §D1–D5 fixes were applied to
> design.md before this rebase and survive the rebase intact).

> Per the user: **nothing committed yet**. The two planning docs
> (`design`, `plan`) remain untracked. Do not push. Do not commit until
> the user has explicitly approved.

## What this session produced

This is the **fourth session** on this feature.

1. Re-read every untracked planning doc with a devil's-advocate eye: "is
   every line / variable / claim necessary, or is it an artifact?"
2. Verified every cited file path and line number in `design.md` and
   `plan.md` against the actual code in the tree today. They all
   resolve cleanly (see §Verified citations).
3. Found **5 stale defects in `design.md`** (§Findings) — all real,
   all fixed in place. `plan.md` was internally consistent and was not
   touched.
4. Per user instruction, **deleted** the three prior handoffs
   (`session-handoff.md`, `review-handoff.md`,
   `rereview-handoff.md`). The audit trail they captured is now
   superseded by the corrected `design.md` + `plan.md` themselves.
5. Wrote this handoff to record the audit before context is cleared.

Current working tree (still untracked, nothing staged):

```
?? docs/plans/2026-05-19-multiplayer-doom-webrtc-design.md           ← revised this session (5 fixes)
?? docs/plans/2026-05-19-multiplayer-doom-webrtc-plan.md             ← unchanged
?? docs/plans/2026-05-19-multiplayer-doom-webrtc-audit-handoff.md    ← this file
```

Branch state unchanged from sessions 1–3 (same 8 commits, newest
`bb3ebb56`).

## Findings — defects fixed in `design.md`

All five were inconsistencies *within* `design.md`, i.e. one part of
the doc contradicting another. Every fix is grounded in `plan.md`'s
load-bearing text — `plan.md` was the tie-breaker.

**§D1 — ASCII diagram L54 used `(pid,fd,…)`.** §2 bullet 2 and §5.1
both commit to port-based addressing `(pid, dst_port, …)`. The
diagram still had the rejected fd-based form, which the rereview
(§S1) claimed to have fixed but missed. Replaced with `(pid,port,…)`.

**§D2 — ASCII diagram L66 used `{ type:"send", dst, port, …}`.**
§5.2's actual postMessage shape is `{ type: "host-send-dgram",
… }`. The diagram had a pre-revision shorthand that didn't match
either the type tag or the field names. Replaced with
`{ type:"host-send-dgram", …}`.

**§D3 — §5.2 TS `send_dgram` signature missing `src_port`.** Plan
Task 1's Rust trait specifies `fn send_dgram(&mut self, src_port: u16,
dst_ip: [u8;4], dst_port: u16, data: &[u8])`. The TS example dropped
the `src_port` parameter entirely. The wire envelope (§5.3 bytes 1-2)
*requires* srcPort, so the kernel must pass it through the shim.
Added `src_port: number` as the leading parameter.

**§D4 — §5.2 postMessage payload missing `src_port`.** Same root
cause as D3. Added `src_port` to the postMessage shape so the main
thread's `RelayChannel` can place it in the wire envelope.

**§D5 — §5.5 MTU "defensive 80% of the SCTP MTU floor".** Arithmetic
error: 1024 / 1200 ≈ 0.853, which is ~85% not 80%. Either the cap
should be 960 (true 80%) or the percentage should be ~85%. Fixed by
restating as "leaves ~15% headroom under the SCTP MTU floor" — keeps
the 1024 cap (a natural round number) and the meaning is the same
(margin under floor).

## Verified citations (spot-checked against the tree)

Every line ref currently cited in `design.md` and `plan.md` resolves:

- `crates/kernel/src/syscalls.rs`: L5170 `sys_sendto`, L5212-5214
  ENETUNREACH branch, L5221-5233 loopback scan, L5236-5243 FIFO push,
  L5251 `sys_recvfrom`, L5279 unconditional EAGAIN, L4141 SOCK_DGRAM
  case, L4780-4867 `sys_bind`, L4895 `host_net_listen` call in
  `sys_listen`, L5154 `sys_getaddrinfo`, L13378 `test_udp_loopback`.
- `crates/kernel/src/wasm_api.rs`: L38 `extern "C"` host imports
  block, L80 `host_net_listen` import, L121 `impl HostIO for
  WasmHostIO`, L491 `host_net_listen` wrapper on WasmHostIO, L8092
  `kernel_inject_connection` export.
- `crates/kernel/src/process.rs`: L25 `pub trait HostIO`, L74-80
  `host_net_*` methods (L80 = `host_net_listen`).
- Six in-test mocks all at the claimed `impl HostIO for X` lines:
  `MockHostIO@8384`, `TrackingHostIO@12187`, `NetMock@12794`,
  `SymlinkMock@14411`, `LoopMock@14506`, `RelSymlinkMock@14591`.
- `examples/browser/lib/browser-kernel.ts`: L407 `injectConnection`,
  L449-475 `sendToKernel` callers (`pipeCloseWrite@449`,
  `wakeBlockedReaders@469`, etc.).
- `examples/browser/lib/kernel-worker-entry.ts`: L193
  `TlsNetworkBackend` instantiation.
- `examples/browser/lib/tls-network-backend.ts`: L143 `export class
  TlsNetworkBackend`.
- `examples/browser/lib/connection-pump.ts`: L30-65 inject +
  pipeWrite + wakeBlockedReaders sequence.
- `examples/browser/pages/webrtc/main.ts`: L154-170 1 Hz ping-pong,
  L260-277 reset path.
- `host/src/kernel-worker.ts`: L881 `onNetListen`.
- `host/src/types.ts`: L79 `interface NetworkIO`.
- `host/src/networking/tcp-backend.ts`: L54 `Atomics.wait` (the
  pattern §4 cites as Node-shaped).
- `examples/libs/fbdoom/build-fbdoom.sh`: L27-31 patch loop.
- `crates/shared/src/lib.rs`: L20 `pub const ABI_VERSION: u32 = 7;`
  — confirms the planned 7 → 8 bump matches reality.

## Architecture invariants (carried forward unchanged)

Same five from the rereview-handoff's "Architecture invariants" — none
slipped during the audit:

- **Port-based addressing** for `kernel_inject_datagram(pid: u32,
  dst_port: u32, src_a..d: u32, src_port: u32, ptr, len) -> i32`.
- **`HostIO::send_dgram`** lives at `crates/kernel/src/process.rs`
  with default `Err(Errno::ENETUNREACH)`. Only `WasmHostIO`
  overrides.
- **New wasm import `host_send_dgram`** in `wasm_api.rs:38`'s
  `extern "C"` block. **New wasm export
  `kernel_inject_datagram`** next to `kernel_inject_connection` at
  `wasm_api.rs:8092`. **`ABI_VERSION: 7 → 8`**, single commit with
  snapshot regeneration.
- **`injectDatagram` is fire-and-forget** — uses `sendToKernel(...)`,
  NOT `request(...)`. Now also: the `RelayHostShim.send_dgram` TS
  example accepts `src_port` and forwards it in the postMessage.
- **No `Atomics.wait`** in browser user code. Kernel's existing
  `dgram_queue` + block/wake is sufficient.
- **`NetworkIO` stays TCP-shaped**; UDP gets its own surface.

## What's still soft (survives into implementation)

Carried from rereview-handoff's "What's still soft" list — none were
resolved this session, and none should block sign-off.

1. **Task 3's `kernel-worker.ts` dispatch site** is "to be located
   during implementation" (file is 6925 lines). The session-1 L4531
   reference was wrong; landmark to mirror is `onNetListen@881`.

2. **Node-host stub for `host_send_dgram`** still lacks a definitive
   file path. Probable: `host/src/node-kernel-host.ts` or
   `host/src/worker-adapter.ts`. Quick scan needed before Task 3
   starts.

3. **Task 4's three pre-flight desk checks** remain real unknowns:
   - fbDOOM's `d_net.c` shape vs chocolate-doom (symbol drift?)
   - whether `sys_getaddrinfo` round-trips literal `10.99.0.1`
   - whether `setsockopt(SO_REUSEADDR)` returns `ENOPROTOOPT`

4. **Channel-close mid-game** — if the channel dies, kernel-worker's
   shim posts into the void (drops, fine) but kernel-side
   `dgram_queue` never gets a teardown signal — DOOM's `select` polls
   forever. v1 accepts this; documented in design §10 as follow-up.

5. **No code has run.** All claims still rest on reading. First
   `cargo build` after Task 1 will surface at least one signature
   tweak (borrow checker, errno coercion, the exact negative-i32
   return convention vs `Errno::ECONNREFUSED`).

## Files I'd touch when implementing (do NOT touch yet)

```
crates/kernel/src/process.rs                        # HostIO::send_dgram trait method + default impl (Task 1)
crates/kernel/src/syscalls.rs                       # L5212 branch → host.send_dgram (Task 1)
crates/kernel/src/wasm_api.rs                       # host_send_dgram extern import + WasmHostIO wrapper + kernel_inject_datagram export (Task 1)
crates/shared/src/lib.rs                            # ABI_VERSION 7→8 (Task 1)
abi/snapshot.json                                   # regenerated (Task 1)
examples/browser/lib/relay-network-backend.ts       # NEW — RelayChannel (Task 2)
examples/browser/lib/browser-kernel.ts              # +injectDatagram (fire-and-forget) (Task 2/3)
examples/browser/lib/kernel-worker-entry.ts         # +RelayHostShim wiring (Task 2/3)
examples/browser/test/relay-network-backend.test.ts # NEW (Task 2)
host/src/kernel-worker.ts                           # +host_send_dgram dispatch (Task 3)
host/src/node-kernel-host.ts                        # ENETUNREACH stub for host_send_dgram (Task 3) — verify path
host/test/centralized-program.test.ts               # +UDP round-trip integration (Task 3)
examples/libs/fbdoom/patches/0002-i_net-posix.patch # NEW (Task 4)
examples/browser/pages/doom-mp/{index.html,main.ts,doom-mp.css,README.md}  # NEW (Task 5)
examples/browser/vite.config.ts                     # +1 rollup input
examples/browser/index.html + each pages/*/index.html  # sidebar link
docs/architecture.md / browser-support.md / posix-status.md / README.md  # Task 7
```

## Verification commands (per CLAUDE.md, applicable subset)

Docs only this session — none run. When code starts:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
cd host && npx vitest run
bash scripts/check-abi-version.sh    # AFTER Task 1's bump, must pass
cd examples/browser && npx vite build
bash examples/libs/fbdoom/build-fbdoom.sh
```

`run-libc-tests.sh` and `run-posix-tests.sh` still do not apply
(user-space POSIX surface unchanged). Real verification is still
Task 6's two-machine smoke test.

## Next-session prompt (paste verbatim)

> Read `docs/plans/2026-05-19-multiplayer-doom-webrtc-audit-handoff.md`,
> then re-read `docs/plans/2026-05-19-multiplayer-doom-webrtc-design.md`
> and `docs/plans/2026-05-19-multiplayer-doom-webrtc-plan.md`. The
> three planning docs are still untracked on branch
> `explore-webrtc-doom-xl7dh`; nothing is committed yet. Either (a)
> help me sign off and commit the planning docs (no push), or (b)
> start Task 1 (kernel ABI hooks — single commit with `ABI_VERSION`
> bump 7 → 8), whichever I tell you. Do not push. Do not commit
> without my explicit sign-off.
