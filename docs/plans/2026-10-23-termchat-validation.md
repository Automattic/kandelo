# termchat port validation, 2026-10-23

This record covers the termchat 1.3.1 registry recipe, shared Rust dependency
portability support, multicast delivery, virtual TCP listener ownership and
absolute futex deadlines. The original validation started from the ABI 51
epoll expansion at `d51ac6d2ce658e9a775d1118db6fbcf49ba510cb` and used
ABI 52 for the corrected futex and networking semantics. The merge refresh
rebases onto `1ddfafc871638785a26675a28899e9af69c0274a`, which introduces
the heap-safepoint process import under ABI 52. Termchat joins that same
batch; its changes introduce no further structural ABI fields or signatures.
`FUTEX_WAIT_BITSET` uses an absolute deadline and `FUTEX_WAIT` remains
relative.

## ABI 52 merge refresh

The four commits were rebased onto the heap-safepoint update at
`1ddfafc871638785a26675a28899e9af69c0274a`, retaining their original
authorship. `scripts/check-abi-version.sh update` regenerated the snapshot,
TypeScript bindings, public C headers and host-import declaration. Those
outputs already match the new main: this port adds no further structural
fields or signatures. The standalone resolver bundle was regenerated and
its test passed. The maintainer requested the same ABI 52 batching pattern,
so no additional ABI-number bump is introduced.

The first full memory-gate run found a real scope violation: the futex
handler called `PlatformIO.clockGettime` while holding kernel-entry
authority. The original focused rerun also failed that audit. The fix
routes the clock sample through the existing synchronous backend-operation
boundary, consumes the provider's result fields there, returns only a
primitive timestamp, and propagates fatal kernel-entry failures. That
helper was renamed from `#invokeSharedMmapHostOperation` to
`#invokeSerializedHostOperation` for its existing mapping callers and the
clock sample. The audits still require the exact entry and reject
asynchronous, nonlexical, or authority-capturing backend callbacks.

All commands below use `scripts/dev-shell.sh`. The final scope change is
host-only; Rust sources and generated ABI outputs remain unchanged after
the workspace and ABI checks.

| Fresh check | Result | Workspace evidence |
|---|---|---|
| Full Rust workspace | Passed, including 2,366 runtime-core cases and doctests | `termchat-abi52-rust-workspace.log` |
| Complete xtask suite | 782 unit cases and all integration binaries passed | `termchat-abi52-xtask.log` |
| Multicast/session/blocking host regressions | 191 passed, no skips | `termchat-abi52-host-regressions.log` |
| Final scope/fatal-error audits, blocking retries, real C futex probe and termchat | 179 passed, no skips | `termchat-abi52-scope-regressions.log` |
| Strict SourceOnly browser TUI and C futex probe | 6 passed across Chromium, Firefox and WebKit | `termchat-abi52-browsers.log` |
| Normal shell with real WebRTC session and two joiners | 1 passed; discovery, both chat directions, file contents and clean exit | `termchat-abi52-webrtc.log` |
| Complete browser memory gate | Passed: 162 host cases, 3 Node and 7 Bun teardown cases, and 9 browser cases; no skips or flaky browser results | `termchat-abi52-memory-final-1023-170519-64eb` agent-job log |
| Final normal SourceOnly bootstrap and admission | All 195 nodes admitted; host build passed | `termchat-abi52-final-prepare-1023-170145-e7a6` agent-job log |
| Browser asset audit | 147 imports resolved; nine memory64 fixtures verified | `termchat-abi52-assets.log` |
| POSIX clock/timed-signal/signal-wait subset | 19 passed, no skips | `termchat-abi52-posix.log` |
| Host typecheck | Passed after the scope fix | `termchat-abi52-typecheck.log` |
| ABI freshness and standalone resolver bundle | Passed | `termchat-abi52-check.log`, `termchat-abi52-resolver.log` |

The normal `./run.sh setup` attempt was deliberately stopped with signal
15 during debug-mode cache validation. The same canonical bootstrap was
completed with the current release xtask binary. After the scope fix, an
additional memory-gate preparation was stopped during debug-mode artifact
admission; a process sample identifies byte-policy scanning and cache-key
hashing as the active work. The release bootstrap then admitted all 195
cached nodes and rebuilt the host. These interrupted runs are not counted
as passing checks. No artifact copying, restamping, or admission bypass
was used.

The final browser checks use a private port, an owned Vite server, strict
SourceOnly resolution, and the current release artifact checker. The Node
application and C probe compose/compile their own test-owned guests using
the current SDK; their private Vitest configuration skips the unrelated
global fixture compiler. The browser memory gate uses its ordinary full
preparation and fixture paths.

The full libc, POSIX and Sortix inventories, independent-build comparison,
and Rust interoperability selection were not rerun for this refresh.
Their earlier results below remain historical evidence, not new runs
against the heap-safepoint update. Guest performance was not benchmarked.

## Original executed evidence before the ABI 52 merge refresh

All build and verification commands run through `scripts/dev-shell.sh`.
Logs and screenshots below are workspace-local files in `.context/`.

| Check | Result | Evidence |
|---|---|---|
| Strict SourceOnly Node application and C futex guest probe | 2 passed, no skips | `termchat-final-host.log` |
| Combined-kernel C futex probe and blocking-retry regressions | 144 passed | `termchat-futex-combined.log` |
| Strict SourceOnly TUI and C futex probe in Chromium, Firefox and WebKit | 6 passed, no skips | `termchat-final-browsers.log` |
| Normal shell and real WebRTC session | 1 Chromium case passed, no skips | `termchat-final-webrtc.log` |
| Browser asset admission | 147 imports resolved; memory64 fixture contract passed | `termchat-final-assets.log` |
| Manual normal UI in native Safari | Startup, input, resize and exit 0 observed; capture caveat below | CUA observations |
| Multicast/session routing and blocking-retry host regressions | 191 passed, no skips | `termchat-host-regressions.log` |
| Full Rust workspace suite | Passed, including 2,366 runtime-core tests and its doctests | `termchat-rust-workspace-final.log` |
| Complete xtask suite | Passed: 718 unit cases and all integration binaries | `termchat-xtask-final.log` |
| Rust full-std and Rust/C/C++ interoperability consumers | 13 passed, no skips | `termchat-rust-host.log` |
| Rust timed parking and condition-variable deadline regression | 1 selected case passed, 6 other cases filtered | `termchat-rust-deadlines.log` |
| Isolated futex build: POSIX clock/timed-signal/signal-wait subset | 19 passed, no skips | `futex-pr/.context/futex-posix.log` |
| Shared Rust sysroot: librsvg and rsvg-convert | Both built in the SourceOnly graph | `termchat-products` agent-job log |
| Host `npm run typecheck` | Passed | `termchat-host-typecheck.log` |
| ABI structural freshness and version-bump check | Passed | `termchat-abi-check.log` |
| Standalone binary resolver bundle | Regenerated and its test passed | `termchat-resolver-bundle.log` |
| Porting skill validation | Passed | `skill-validation.log` |
| Independent default-policy termchat builds | Identical complete executable bytes | `termchat-reproducibility.json` |
| Normal SourceOnly termchat build and publication | Passed | `termchat-bootstrap-final.log` |
| Combined-runtime Sortix UDP conformance | 199 passed, 13 expected failures; no skips/timeouts | `futex-pr/.context/termchat-udp.log` |
| Complete SourceOnly graph and admission | 195 nodes and eight products succeeded | `termchat-products-result.json` |

The browser command was:

```sh
cd apps/browser-demos
KANDELO_PLAYWRIGHT_PORT=5527 npx playwright test test/termchat.spec.ts \
  --project=chromium --project=firefox --project=webkit --workers=1
```

It loads the real resolver-owned executable into production BrowserKernel
workers with guest PTYs and xterm. Two machines discover each other, exchange
messages in both directions, transfer and compare all 32,775 binary bytes,
resize the terminals, exchange another message, announce disconnection,
restore the alternate screens and leave no child processes. Stderr and host
diagnostics must be empty. Screenshots are
`termchat-browser-{chromium,firefox,webkit}.png`. The transport in this
fixture is the production remote session protocol over MessageChannels;
it does not prove WebRTC invitation and signalling behavior.

The focused host command was:

```sh
cd host
npx vitest run test/virtual-network.test.ts test/remote-segment.test.ts \
  test/remote-session-network.test.ts \
  test/kernel-blocking-retry-snapshot.test.ts
```

Rust SDK validation used a private `KANDELO_RUST_DIR` and ran
`test/rust-std.test.ts` and `test/rust-c-interop.test.ts`. The real application
resize test initially exposed the Rust libc crate's incorrect wasm32 signal
mask size. The shared libc overlay now checks the mask and sigaction layout
at compile time; the subsequent three-engine application test passes.

The added `std-boundaries` checks call `thread::park_timeout` and
`Condvar::wait_timeout_while` without an unpark/notification and require
their deadlines to expire. The selected `runs std-boundaries` Vitest case
passes on Node. This follow-up reused the already-completed ordinary host
global setup through a private config with `globalSetup: []`, avoiding
another shared program-index rewrite during the active product build.
The SDK test still built and ran its real Rust guest normally.

Two independent default-policy cache roots produced a 1,654,728-byte
executable with SHA-256
`fe63ad0225f75bf17dd1aa5a6d63f669bdf3ffffa2852a46a0e880bffe6e8e3c`.
The builds use different private work directories and Cargo homes. The
shared helper keeps path dependencies inside the staged Cargo workspace,
keeps std's libc fork inside its sysroot, and remaps compiler source paths.
Earlier attempts differed at one cache key; the resolver correctly rejected
those publications instead of replacing an existing winner.
The original SourceOnly executable's sections matched these builds except
for the build-key and ABI-contract custom sections. Its ABI-contract digest
matched the pre-refresh snapshot and SourceOnly kernel.

### Original product and conformance validation

The original complete ABI-bound SourceOnly graph passed: 195 nodes, including
eight products, and normal artifact admission succeeded. The result is
`termchat-products-result.json`; the agent-job log is
`termchat-products-1023-131848-bfc3`. Both librsvg and rsvg-convert built
successfully with the shared Rust sysroot change.

An earlier attempt hit `local-build graph authority inputs changed while
planning` for pixman while a concurrent program-index transaction changed
the registry directory inventory. That attempt was stopped, retaining
completed package cache entries. It is not counted as a passing run.

Earlier Node application, libc basename preflight and browser asset
audit attempts were rejected during artifact resolution: concurrent narrow
publications replaced the admitted projection with different subsets.
They did not reach the guest behavior under test. The complete graph
repaired admission through the normal build engine. No manual copying,
ABI restamping or admission bypasses were used.

The final checks use the admitted SourceOnly projection and this server:

```sh
scripts/dev-shell.sh ./run.sh browser \
  --host 127.0.0.1 --port 5537 --strictPort
```

The Node application/C probe passed two cases;
the browser TUI/C probe passed six cases across all three engines. The
normal shell/WebRTC case passed on Chromium, with two joiners discovering
each other through the host, chatting both ways, transferring a file and
exiting cleanly. Its command selects `--grep "termchat discovers"` in
`test/kandelo-network-session.spec.ts`. An earlier anchored filter selected
no tests; that selection error is not counted as a passing run.
Screenshots are `termchat-session-{alice,bob}.png`. The browser asset audit
then resolved all 147 imports, including termchat.

Manual native Safari verification used the same normal server. Through
the UI, it hosted a disposable session, launched `termchat -u manual`,
entered messages, resized the window, pressed Escape and observed
`termchat_exit=0` with the shell restored. The session was left and the
test tab closed. Native window captures initially showed blank/stale
terminal pixels, including before termchat launched, and refreshed after
window zooms. This records the observed startup/input/resize/exit behavior;
it does not establish continuous native Safari painting behavior.

The isolated futex-only ABI 52 build completed libc functional/regression:
120 passed, three expected failures, one flaky stress pass, and one
`raise-race` timeout at the default 30 seconds. The command exits nonzero;
this is not a clean suite result. The isolated `raise-race` rerun passes
with `TEST_TIMEOUT=120` (`futex-pr/.context/futex-raise-race-120.log`).
The initially requested POSIX timed-thread interfaces are absent from the
repository's curated suite, so that command did not run any tests. A
follow-up selects the available clock and timed-signal interfaces. Cold
checker builds initially exhausted the per-test watchdog before guest
execution. Preparing the current release checker outside that watchdog
and passing its supported `WASM_POSIX_XTASK_BIN` path resolves preparation;
the unchanged POSIX tests then pass: 19 passed, no skips. The log is
`futex-pr/.context/futex-posix.log`.

Combined-runtime Sortix UDP conformance passes: 199 passed, 13 expected failures, no skips,
build failures or timeouts. The validation worktree was moved to the
combined PR commit, rebuilt its current release checker, and normally
bootstrapped its kernel/rootfs. `verify-fresh` passes. Sortix source comes
from the pristine case-sensitive checkout pinned at `7e8f008`; the original
case-insensitive submodule's pre-existing dirt is preserved.

### Original futex split experiment

The futex correction is a distinct platform fix, but it is required for
termchat's complete file-transfer behavior on Node. With only the absolute
futex conversion removed, discovery and bidirectional chat work, but a
32,775-byte transfer stalls at 32,768 bytes. With the conversion restored,
the isolated file-transfer test passes. Repeating the isolated test with
the old conversion reproduces the failure. The same ABI 52 kernel, guest
executable, source image and network changes are used in both runs; only
host timeout conversion changes. Evidence is `termchat-file-fixed.log`,
`termchat-file-old.log` and `termchat-file-ab.json` in `.context/`.

Upstream `src/commands/send_file.rs` sends 32 KiB chunks and schedules its
next action after 100 microseconds. A basic chat smoke test cannot exercise
that timed continuation. Without the correction, the full browser lifecycle
still passes in Chromium, Firefox and WebKit (`termchat-browser-without-futex.log`),
so those passes alone do not establish correct Node behavior.

The first full Node control with the fix restored falsely rejected Bob's
notification: tui emitted only the changed ` is offline` cells, reusing the
username already on screen. The raw-stream assertion now checks that emitted
suffix for the only peer. The browser xterm test checks the complete rendered
message. The complete Node lifecycle then passes, including file contents,
resize, both clean exits, terminal restoration and process cleanup
(`termchat-node-final-control.log`).
The user chose to keep the prerequisite and port together in one PR,
with focused commits preserved by a later rebase merge. The isolated
futex-only worktree supplies additional platform regression evidence;
it is not a separate PR.

## Scope and boundaries

Discovery works between Kandelo machines on the same virtual link/session.
Browser sandboxing prevents discovery of arbitrary native physical-LAN
computers. The optional Linux V4L webcam feature is disabled. The room sends
messages and files to all peers; it does not supply private conversations.

Multicast remains partial: explicit interface selection has the documented
loopback/10.88 validator, group-address binds are unsupported, TTL is stored
without router enforcement, IPv6 multicast is unsupported, and some mutable
UDP state remains process-local across fork. Default discovery on a 10.89
session uses the actual host interface. Futex selective bitset wake and
realtime clock changes during an armed host wait remain unsupported. These
limits are described in the architecture and POSIX support references.

No performance benchmarks, physical-LAN/native-peer interoperability,
complete libc math suite, complete POSIX/Sortix suite, Linux-completeness
claim or release publication is included in this record. Repository
GitHub Actions is disabled at publication, so no hosted CI or merge-gate
success is claimed. The combined PR uses rebase merge to preserve its
four focused commits.
