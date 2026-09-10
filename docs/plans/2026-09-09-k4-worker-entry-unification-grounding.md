# K4 grounding — unify the two host worker entries

> Read-only grounding for census item **K4** (`docs/plans/2026-09-09-whole-kernel-rust-migration-census.md`
> §3 F1, §10 K4). No repository code was modified. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch `integration/k-tier1-20260909`.
> Written 2026-09-09.
>
> Every claim below is labelled **VERIFIED** (measured or executed in this
> worktree) or **INFERRED** (read from code, not run). Four inherited "floors"
> have already been disproved by re-test in this campaign, so nothing
> load-bearing here rests on recollection.

---

## 0. Verdict up front

1. **The F1 framing is correct and, if anything, conservative.** The census
   says 54 identically-named functions. There are 54 by name *plus* at least
   one renamed pair (`handleTerminate` / `handleTerminateProcess`) and four
   more renamed near-twins, so the duplicated-function count is **≥ 55**.
2. **The pairs have drifted.** Only **13 of 54 are byte-identical**. 17 more
   differ cosmetically only. 8 differ for a real host reason. **16 carry
   substantive behavioural divergence**, of which several are latent parity
   bugs, itemised in §1.3.
3. **K4 does NOT depend on K3.** The census dependency is not supported by the
   call sites: exactly **two lines** of a unified entry would need re-touching
   by K3 (§5). The arrow arguably points the other way.
4. **`parseShebang` is not "three copies of one algorithm".** It is one Rust
   *parser* already reachable from both hosts, plus two TS clones used only in
   a spawn *preflight* whose argv the kernel then throws away — and three
   independently written *chain* policies that disagree on depth and errno
   (§3). Both TS copies are deletable today with **no new host surface and no
   ABI motion**.
5. **Architecture: stage it.** Step 1 = one shared TypeScript lifecycle module
   (delivers V1 now, no host-surface growth, makes the drift impossible).
   Step 2 = the Rust move, which becomes tractable *because* step 1 leaves one
   algorithm to port instead of two divergent ones. Going straight to Rust
   means porting two implementations that disagree, in the campaign's most
   delicate code, with the browser half largely untested in CI (§4, §7).
   Whether step 2 is mandatory is a **NEEDS-DEFER-DECISION** (§8).

---

## 1. Are the 54 pairs equivalent, or have they drifted?

### 1.1 Method (VERIFIED, reproducible)

Top-level `function` declarations were extracted from both files by regex plus
column-0 closing-brace matching, then compared body-for-body:

```
python3 <extract.py>   # scratchpad only, not committed
browser fns: 95   node fns: 68   common by name: 54
```

Line accounting (VERIFIED):

| | browser entry | node entry |
|---|---|---|
| file | 4,847 | 4,260 |
| lines inside the 54 common-named functions | **3,582** (74%) | **3,136** (74%) |
| lines inside host-only-named functions | 524 (11%) | 372 (9%) |
| top-level (imports, constants, state, message switch) | 742 (15%) | 753 (18%) |

So the duplicated-algorithm volume is **≈ 6,718 lines across the two files**,
not the ~9,100 the census quotes for the two files entire. The census figure
is the file total; the *duplication* figure is 6,718, of which roughly 3,100 –
3,600 disappear on unification, plus a large share of the 1,495 top-level
lines (the constants, the ProcessInfo state containers, and the message
dispatch switch are also written twice).

### 1.2 The four-bucket classification (VERIFIED by diff of all 54 pairs)

| bucket | count | meaning |
|---|---|---|
| **byte-identical** | **13** | `handleFork`, `completeVforkGenerationTeardown`, `parseShebang`, `handleVmInterruptTimer`, `reportHostDiagnostic`, `handlePosixSpawnResolve`, `releaseVforkWorkspace`, `traceVforkMechanism`, `execOverlayRetryDelay`, `postForkModuleProof`, `respond`, `respondError`, `signalFromExitStatus` |
| **cosmetic drift only** (semantically identical) | **17** | identifier renames, comment rewording, diagnostic string prefix (`[node-kernel-worker]` vs `[browser-kernel-worker]`), `formatError()` vs an inline ternary, `PAGE_SIZE` vs `WASM_PAGE_SIZE` (both 65536, `generated/abi.ts:924`), `NodeWorkerAdapter` vs `BrowserWorkerAdapter` type params |
| **justified host difference** | **8** | `forkModuleInitFields`, `handleHttpRequest`, `handleInit`, `createFreshProcessMemory`, `terminateTrackedWorker`, `terminateThreadWorkers`, `resolveExecutableForLaunch`, `handleExportRootfsImage` |
| **substantive drift** | **16** | listed in §1.3 |

**30 of 54 (56%) are semantically equivalent today.** That is the good news for
K4 and it is also the danger: 56% equivalence is exactly the state that makes
a reader assume 100% and stop checking.

### 1.3 The substantive drifts, each classified

Every row is **VERIFIED** by reading both bodies unless marked.

| # | site | divergence | classification |
|---|---|---|---|
| D1 | `handleClone` reclaim path (`browser…:151-172`, `node…` twin) | browser gates thread-slot reclaim on `threadEntry.quiescent` and sets `processInfo.memoryRetirementSafe = false` when the fence is absent; **node frees `threadAllocator.free(alloc.basePage)` unconditionally** | **latent parity bug (Node)** — node recycles a thread's address-space slot without proof the thread worker stopped. Node itself treats quiescence as unproven for the *process* lease (`finishProcessExit`), so this is internally inconsistent. INFERRED that it is exploitable; not reproduced. |
| D2 | `finishProcessExit` duplicate-exit guard | node: `processTeardowns.get(worker)` → `reportProcessExit(pid, status)` then return. browser: `if (processTeardowns.has(worker)) return;` — **posts nothing** | **latent parity bug** — a second exit notification is reported on Node and silently dropped in the browser. Node's re-report is deliberate and commented. |
| D3 | `finishProcessExit` fence ordering | node awaits worker quiescence and thread termination **concurrently** (`Promise.all`); browser awaits them **sequentially** | drift; different race exposure and different teardown latency |
| D4 | `finishProcessExit` crash synthesis | browser calls `kernelWorker.notifyHostProcessCrashed(pid, crashSignum)` inside `finishProcessExit`; node calls it from `finalizeProcessWorker` (a node-only function) | same POSIX requirement, two structurally different homes. The browser comment says *"Mirrors `finalizeProcessWorker` in host/src/node-kernel-worker-entry.ts"* (`browser…:3826-3834`); the node comment says *"The browser entry funnels the same events through finishProcessExit(), whose teardown-map guard provides this ordering directly"* (`node…:697-701`). **The code documents its own duplication in both directions.** |
| D5 | `handleSpawn` argument validation | node rejects "both or neither of programBytes/programPath" with an explicit error; browser accepts both and silently prefers `programBytes` | drift; boot-descriptor/spawn input is untrusted-adjacent |
| D6 | `handleSpawn` → `setMaxAddr` | node honours `msg.maxAddr`; **browser never calls `setMaxAddr`** (VERIFIED: 0 occurrences in the browser entry, 1 in node) | **one-host-only spawn option** |
| D7 | `handleSpawn` → `maxPages` | browser honours `msg.maxPages` as a per-process memory cap; node ignores it | **one-host-only spawn option (converse)** |
| D8 | `handleSpawn` → `programModule` | node forwards a caller-supplied precompiled `WebAssembly.Module`; browser drops it and recompiles | one-host-only option; a startup-latency divergence |
| D9 | `handleSpawn` → `cwd` | browser puts `cwd` in the `centralized_init` message *and* calls `setCwd`; node calls `setCwd` only | drift in what `worker-main` observes |
| D10 | `handleExec` failure rollback | browser tracks `replacementStartAttempted` and picks `releaseAfterForcedTermination()` when a start was attempted; **node always `prepared.memoryLease.release()`** on that path, commented "was never started" | **latent parity bug (Node)** if the path is reachable after a start attempt — an exact release hands the backing to another process. INFERRED reachability. |
| D11 | `handleExec` old-generation termination | node routes through `terminateTrackedWorker`; browser inlines `intentionallyTerminated.add` + `forkHostImports.close()` + `worker.terminate()`, so the teardown is **not registered in `workerTeardowns`** | drift; the browser bypasses its own tracking helper on one path |
| D12 | `handleExec` `startDisposition === "dead"` | node terminates the replacement worker; browser instead settles `workerQuiescence` and does not terminate | drift with different rationales; probably equivalent, INFERRED |
| D13 | `handlePipeRead` / `handlePipeWrite` / `handleInjectConnection` | node has an `initReady` guard returning `uninitializedKernelPipeResult(...)` (6 uses); **browser has no such guard** (0 uses) and instead throws into `respondError` | **one-host-only failure mode** — different observable result for the same pre-init pipe operation |
| D14 | `handleReadVfsFile` | browser supports `msg.includeMode` and returns `{data, mode}`; node has no `includeMode` at all | **one-host-only protocol feature** |
| D15 | `handleOrdinaryFork`, `handleSpawn`, `performDestroy` | browser inserts `await waitForProcessTeardowns()`; node has no such barrier (VERIFIED: 6 uses browser, 0 node) | drift; a browser-only serialisation with throughput and ordering consequences |
| D16 | `ProcessInfo` shape | browser's generation record carries `generation`, `memoryRetirementSafe`, `framebufferExposed`, `argv`; node's carries none of them | **the browser's whole memory-retirement safety model has no Node counterpart.** `memoryRetirementSafe` has 7 browser sites, 0 node sites. |
| D17 | `performDestroy` | node clears `vmInterruptTimers` per process; **browser does not** | **latent browser bug candidate** — a VM interrupt timer survives destroy. Relevant to image-switch teardown. |
| D18 | `performDestroy` lease release | node may exactly `release()` a quiescent lease at destroy; **browser always `releaseAfterForcedTermination()`** | drift with a real cost: on browser no process backing is ever exactly reclaimed at destroy. INFERRED that this contributes to image-switch memory retention; not measured. |
| D19 | `handleExec` diagnostics | browser writes `globalThis.__pidMap` (a debug side table) into the production path | production debug scaffolding, browser only — the same class as the `#createTestAuthority` finding in `kernel-worker.ts` |
| D20 | test-injection hooks | browser has `injectVforkWorkerStartFailure` and an elaborate `Object.defineProperty` getter-throws injection that simulates a *postMessage* failure; node has neither, and node additionally reads `process.env.KANDELO_TEST_...` which the browser cannot | **the failure-injection surface differs per host**, so the two hosts' rollback paths are not tested the same way |
| D21 | `handleTerminate` (node) / `handleTerminateProcess` (browser) | same function, different name; node inlines thread termination without the settle delay and without reusing `t.termination` | renamed twin — **the "54 identically-named" count misses it** |
| D22 | `handleVfork` parent guard | node requires truthy `parentInfo.programBytes` (`!parentProgram` → throw); browser requires only `parentInfo` | drift in the error path only |

### 1.4 Renamed twins the name-match missed (VERIFIED)

Beyond D21: `readExecFromVfs`/`resolveExec`/`resolveExecLocal` (node) vs
`readExecFileFromFs`/`readFileFromFs` (browser); `finalizeProcessWorker` +
`finalizeProcessWorkerError` + `finalizeUnexpectedWorkerError` +
`processWorkerErrorDisposition` + `unexpectedWorkerCrashDisposition` (node, 84
lines) vs the `finalize` closure inside `installProcessWorkerListeners`
(browser); `waitForWorkerQuiescence`/`waitForExecRetirement` (browser thin
wrappers with default timeouts) vs direct calls to the shared
`worker-quiescence.ts` with explicit constants (node). The constants agree:
`PROCESS_WORKER_QUIESCENCE_WAIT_MS = 100` and
`EXEC_WORKER_RETIREMENT_WAIT_MS = 5000` are declared separately in both files
with identical values (`browser…:280-281`, `node…:265-266`).

### 1.5 The maintenance-cost measurement (VERIFIED)

Since 2026-06-01, **105 commits touched at least one entry file and 73 of them
(70%) touched both.** The `phase5-tmpfs-cutover-fork-blocker` fix is the
archetype: commit `fd0509be1` (rebased as `9e1272b56`) is one semantic change —
"wrap fork-child `registerProcess` in `retryKernelEntryResult`" — and it cost
`+27/-11` in the browser entry and `+30/-11` in the node entry, in both fork
branches each. Both hosts carry the fix today (`browser…:2158`, `:2553`;
`node…:2002`, `:2384`), so this one did not drift — but it is a fair sample of
the tax, and 16 substantive drifts show that the tax is not always paid.

**This 70% figure is the strongest single V1 argument in the census.**

---

## 2. What is genuinely host-specific?

### 2.1 The abstraction already exists (VERIFIED — this changes the estimate)

The census predicts the residue is "constructing a Worker, constructing a
`WebAssembly.Memory`, posting a message". That prediction is **already
implemented**: `host/src/worker-adapter.ts` defines `WorkerHandle` /
`WorkerAdapter` (`createWorker`, `on("message"|"error"|"exit")`, `off`,
`terminate`), with `NodeWorkerAdapter` there and `BrowserWorkerAdapter` in
`host/src/worker-adapter-browser.ts` (101 lines). Both entries already consume
it. `DeferredWorkerHandle` (`host/src/deferred-worker-handle.ts`) is shared.
`WebAssembly.Memory` construction is already behind
`processMemoryAllocator.acquireWhenAvailable(...)` in the shared
`host/src/process-memory.ts`.

So the two entries do **not** differ because Worker or Memory construction
differs. They differ because they were written twice.

### 2.2 Import overlap (VERIFIED)

**31 shared imports** vs **11 host-only each**:

- shared: `constants`, `deferred-worker-handle`, `exec-target`,
  `fork-externref-process-owner`, `fork-host-import-runtime`,
  `fork-mechanism-trace`, `fork-reference-broker`, `fork-replay-gate`,
  `generated/abi`, `kernel-entry-retry`, `kernel-realm-destroy`,
  `kernel-worker`, `process-generation-detach`, `process-memory`,
  `process-memory-creator-gate`, `rootfs-snapshot-gate`, `thread-allocator`,
  `thread-exit-coordinator`, `thread-worker-disposition`, `trap-signals`,
  `vfork-lifetime`, `vfs/closed-lazy-assets`, `vfs/lazy-url`,
  `vfs/rootfs-lazy-archives`, `vfs/rootfs-manifest`,
  `vfs/rootfs-overlay-export`, `vfs/types`, `vm-interrupt-timer`,
  `worker-main`, `worker-protocol`, `worker-quiescence`
- browser-only: `browser-immediate-polyfill`, `browser-kernel-protocol`,
  `browser-kernel-vfs-init`, `networking/browser-mitm-ca-env`,
  `networking/tls-network-backend`, `vfs/browser-lazy-fetcher`,
  `vfs/device-fs`, `vfs/memory-fs`, `vfs/time`, `vfs/vfs`,
  `worker-adapter-browser`
- node-only: `audio/node-pcm-driver`, `binary-resolver`,
  `kernel-pipe-transport`, `networking/tcp-backend`, `node-kernel-protocol`,
  `platform/node`, `types`, `vfs`, `vfs/default-mounts`,
  `vfs/default-mounts-node`, `worker-adapter`

### 2.3 True residue after unification (VERIFIED line counts, INFERRED grouping)

Of the 524 browser-only + 372 node-only function lines, only these are
genuinely host-bound:

| host | genuinely host-specific | lines |
|---|---|---|
| node | `buildVirtualPlatformIO` (host FS mounts) | 104 |
| node | `installCrashSafetyNet` (`process.on` handlers) | 26 |
| node | `cleanupSessionDir` | 16 |
| node | `resolveExecLocal` (real-filesystem exec) | 18 |
| browser | `releaseMainFramebufferGeneration` + `acknowledgeMainFramebufferRelease` | 43 |
| browser | lazy-registration family (5 fns, service-worker/VFS fetch) | 64 |
| browser | `handleHttpRequestMessage` + bridge-request accounting (5 fns) | 45 |
| browser | `handleAudioDrain`, `handleMouseInject` | 21 |
| browser | `processWorkerTerminationSettleMs` + `readServiceLogForProcess` | 20 |
| **total** | | **≈ 357** |

Plus the host-specific part of `handleInit` (VFS init, mounts, networking
backend, framebuffer wiring) — the largest single diff at 357 changed lines,
and mostly legitimate. Notably, `handleInit`'s **kernel-callback wiring block
is near-identical in shape on both hosts**: `onProcessMemoryTarget`,
`onKernelFatal`, `onFork`, `onExec`, `onCommitFailure`, `onResolveSpawn`,
`onSpawn`, `onClone`, `onThreadExit`, `onExit`, `onStdout`, `onStderr` appear
in the same order in both (`node…:51-195`, `browser…:161-304`).

**Estimate: ~360 lines of genuine per-host residue plus a host-specific
`handleInit` prologue, against ~6,718 lines of duplicated algorithm.**
The remaining ~150 lines of "host-only" functions (`delay`, `basename`,
`formatError`, `bufferToArrayBuffer`, the quiescence wrappers) are utility
duplication, not host difference.

The two exceptions worth naming as **real boundaries**, not accidents:

1. `forkModuleInitFields` — the browser ships only the wasm32 fork module
   (bundled), node reads `fork_module{32,64}.wasm` from disk. A wasm64 guest in
   the browser gets `{}` and fails loud, which is the truthful failure the
   platform-values contract asks for.
2. `processWorkerTerminationSettleMs` — a **Chrome compatibility delay** keyed
   on `argv[0]` being `node`/`spidermonkey-node`. Its own comment says it
   "never proves Memory retirement safe". This is a documented browser-engine
   boundary, but keying a teardown delay on the *program's name* is
   program-specific behaviour in the platform, which the platform-values
   contract disfavours. Worth revisiting during K4; not a blocker.

---

## 3. `parseShebang`: the three-way (really five-site) verdict

VERIFIED, including executed tests (see §3.4).

### 3.1 The framing is partly wrong

The census says three copies. There are **four `#!`-handling sites plus a
fifth `#!` predicate**:

| # | site | parses | chains |
|---|---|---|---|
| 1 | `crates/runtime-core/src/exec_target.rs:294` `parse_shebang`, `:675` `resolve_shebang` | Rust | Rust — **1 level**, then `ENOEXEC` |
| 2 | `host/src/exec-target.ts:389` `launchPreparedExecTarget` | **Rust**, via `kernel_exec_target_shebang` (`crates/kernel/src/wasm_api.rs:3111`); the host only decodes the record (`host/src/exec-target.ts:261`) | hand-written TS — **1 level**, then `ENOEXEC` |
| 3 | `host/src/browser-kernel-worker-entry.ts:302` / `:314` | TS clone | TS — **4 levels**, then `null` |
| 4 | `host/src/node-kernel-worker-entry.ts:1085` / `:1097` | TS clone | TS — **4 levels**, then `null` |
| 5 | `crates/runtime-core/src/exec_target.rs:228` `is_script()` = `starts_with(b"#!")` | a third, different predicate | n/a — gates set-ID suppression (`:769`, `:841`) |

`kernel_exec_target_resolve_shebang` (the export the census names) is bound
**only** by host-native (`crates/host-native/src/guest.rs:1215-1217`) —
VERIFIED. But the *same Rust parser* is already reachable from both TS hosts
through the separate `kernel_exec_target_shebang` export, and site 2 already
uses it on the authoritative exec **and spawn** path
(`host/src/kernel-worker.ts:23650`, `:23712`).

### 3.2 Do they agree?

**On parsing: yes.** The Rust `parse_shebang` is an explicit, documented port
of the TS one (`exec_target.rs:283-293`), reproducing JS `String.trim`,
`/\r$/`, `/^(\S+)(?:\s+(.*))?$/`, the full JS `\s` set, and the 4096-byte line
cap. `parseShebang` itself is **byte-identical** between the two entries; its
caller `resolveExecutableForLaunch` differs in **exactly one line** — the byte
source (`readExecFileFromFs` vs `resolveExec`). VERIFIED by diff.
**On chaining: no.** Rust and `exec-target.ts` allow **one** shebang level and
fail `ENOEXEC`. The two entry copies allow **four** (`MAX_SHEBANG_DEPTH = 4`)
and return `null`, which their own doc comments define as **ENOENT**
(`node…:3042`).

### 3.3 The live POSIX bugs this exposes

1. **Nesting depth is 1, not 4, on every host.** `kernel-worker.ts:22427-22430`
   explicitly discards the preflight's rewritten argv — *"Preserve the blob's
   original vector so the authoritative child-state target parser performs that
   rewrite exactly once"* — and re-resolves through `exec-target.ts`, which
   stops at one level. Linux allows 4 (`fs/exec.c`, "4 levels of binfmt
   rewrites"). The TS copies' Linux-matching depth is **illusory**: they read
   files 4 deep and then their answer is thrown away. This is a **real POSIX
   gap on all hosts**, and it is *masked* by the duplication.
2. **Wrong errno at exhaustion.** The preflight's `null` becomes ENOENT — "the
   file does not exist" — for a file that plainly exists. Linux returns ELOOP;
   the Rust path returns ENOEXEC. ENOENT is the worst of the three.
3. **The preflight is a redundant file read** on every spawn, up to 4 deep.
4. `is_script()` and `parse_shebang` disagree by construction on `#!   \n` and
   on a CR-in-argument line. The direction is fail-safe (set-ID suppressed for
   anything starting `#!`), so this is a consistency wart, not a hole.
5. Shared divergences from Linux in **all** implementations (so not a parity
   issue, but worth a documented gap entry): CRLF is tolerated where Linux
   would fail ENOENT; JS non-ASCII whitespace (NBSP, `\v`, `\f`, U+2028, BOM)
   acts as a separator where Linux honours only space and tab; the line cap is
   4096 with **silent truncation** where modern Linux caps at 128 and returns
   ENOEXEC; invalid UTF-8 becomes U+FFFD where Linux preserves raw bytes; an
   embedded NUL is retained where Linux terminates the line.

### 3.4 Evidence

- `cargo test -p runtime-core --target aarch64-apple-darwin --lib` —
  `exec_target::tests` **9 passed**, `syscalls::tests::resolve_shebang_*`
  **4 passed**. Gotcha for reruns: `.cargo/config.toml` sets
  `[build] target = "wasm32-unknown-unknown"`, so the explicit
  `--target aarch64-apple-darwin` is required.
- The TS `parseShebang` body was run under Node 24 against 27 edge-case inputs
  in the scratchpad (no repo file created): `#!` + 8192 `a` → a 4094-character
  interpreter; NBSP/`\v`/`\f` act as separators; a leading BOM is trimmed;
  `#!/bin/sh a\rb\n` → `null`; invalid UTF-8 → U+FFFD; NUL retained.
- The Linux column is **INFERRED-FROM-KERNEL-SOURCE-KNOWLEDGE**; this host is
  darwin. A Linux VM with `#!` fixtures would settle it cheaply.
- **No conformance suite exercises `#!` semantics.** The `tests/posix` hits are
  `.sh` files that merely *have* shebangs. `host/test/prepared-exec-target.test.ts`
  mocks `kernel_exec_target_shebang`, so it covers the chain, not the parse.

### 3.5 The K4 action

Delete both entry-file `parseShebang` + `resolveExecutableForLaunch` copies by
routing `onResolveSpawn` through the *existing* `kernel_exec_target_shebang`
that the exec path already uses. **No new host import. No ABI motion. No new
Rust.** Then fix the depth-1 gap once, in `exec_target.rs`, where all hosts
inherit it. Track the ENOENT→ENOEXEC/ELOOP correction with it.

---

## 4. Where should the unified logic live?

This is the core question and it does not have the answer the census assumes.

### 4.1 What the entries actually contain

The entries call **58 distinct `kernelWorker.*` methods** (VERIFIED, browser
common-function set). The POSIX decisions are **already in Rust**:
`shouldLaunchPendingChild`, `prepareProcessForExec`,
`finalizeExecHandoffTermination`, `validateExecMetadata`, `processSecureExec`,
`isExecHandoffActive`, `takeCommittedExecTransition`,
`finalizePendingChildTermination`, `notifyHostProcessCrashed`,
`reapHostOwnedExitedProcess`. The kernel decides *whether* a child may launch,
*whether* an exec may commit, *what* signal a handoff death carries, and *what*
the exec target resolves to.

What the entry files own is **transactional choreography over host objects**:
compile a `WebAssembly.Module`, acquire a memory lease, zero a channel,
construct a `DeferredWorkerHandle`, install listeners, await a
`memory_quiescent` fence, terminate a Worker, then release or force-retire the
lease — with a rollback path for every partial failure. That is the ~3,100
lines. It is not POSIX decision-making; it is *ordering and ownership of host
objects under failure*.

**This is the finding that decides the architecture, and it cuts against a
naive "move it to `runtime-core`".** Rust cannot hold a `WebAssembly.Memory`,
a `Worker`, or a `Promise`. To drive this sequence from Rust, every one of
those operations becomes a call back out to the host. Whether that is a host-
surface *increase* depends entirely on the encoding: as separate imports it is
a clear V4 loss; as one opcode-tagged command list it may cost a single import
(§4.2(a)). Either way the burden of proof sits with the Rust option, which is
what the "STRONG DOUBT on adding host surface" rule exists to enforce.

### 4.2 The three candidates, argued honestly

**(a) `crates/runtime-core`, driven through kernel exports.**
Delivers V1 + V2 + V4 in principle. But kernel exports are **synchronous** and
reentrancy-gated (`#runOrDeferKernelEntry`, `KernelReentrantEntryError`), and
this algorithm is a multi-`await` transaction. It would have to become a
host-pumped state machine: *host asks "what next?", kernel returns a typed
command, host executes it, host reports the outcome, repeat.*

**That pattern is not hypothetical — this repository already ships it, and at
a host cost of one import.** VERIFIED:

- `crates/fork-module` is **5,362 lines of Rust with 71 exports** and requires
  **exactly one** host function (`crates/fork-module/src/lib.rs:190-195`):
  `#[link(wasm_import_module = "env")] fn __wpk_fork_drive_plan(plan: usize, count: u32)`
  — plus `env.memory` and the placement globals. It exists only because Rust
  has no `call_indirect` intrinsic.
- The command encoding is `DriveStep`, `crates/fork-codec/src/drive_plan.rs:258`:
  **13 opcodes, 16-byte records**, executed *identically* by
  `crates/host-native/src/guest.rs:4835-4837` and
  `host/src/fork-module-backend.ts:417-434`.

So "the kernel authors a typed command list and every host executes the same
opcodes" is a **proven** Kandelo pattern with a near-zero host contract. That
substantially weakens my first estimate of ~9 new primitives: a K4b command
list could plausibly ride one import the same way.

**Two honest caveats before treating that as settled.** First, `DriveStep`
opcodes are **synchronous, in-address-space** operations (`call_indirect`,
memory writes). Worker construction, module compilation, and the
`memory_quiescent` fence are **asynchronous and cross-worker**. The precedent
proves the *encoding and dual-host execution*; it does **not** prove that an
async, rollback-heavy, multi-worker transaction can be sequenced from
synchronous Rust. That is K4b's open question and it deserves a probe, not an
analogy.

Second — a warning, not an encouragement — **this seam was already cut once
and abandoned.** `kernel_is_fork_child` / `kernel_get_fork_exec_path`
(`crates/kernel/src/wasm_api.rs:12207`) / `_argv` (`:12222`) / `_argc`
(`:12242`) / `kernel_apply_fork_fd_actions` (`:12252`) /
`kernel_clear_fork_exec` (`:12311`) is precisely a "host asks: am I a fork
child, and what should I launch?" protocol, and it is **stubbed to `0` in both
hosts** (`host/src/worker-main.ts:495-506`,
`crates/host-native/src/guest.rs:5432`). Before K4b reinvents it, find out why
it died. If the reason was asynchrony, that is K4b's blocker; if it was
"never finished", that is an argument *for* K4b. It must not be re-derived by
guesswork — this campaign has already disproved four inherited floors.

**Residual risk regardless:** this is the campaign's most delicate code, its
browser half is barely covered in CI (§7), and (a) rewrites *and* relocates it
in a single step.

**(b) A co-resident Rust PIC side module (`fork-module` pattern).**
Same async problem, plus the module lives in the *guest's* address space while
this code runs in the *kernel worker*. Process lifecycle spans workers that do
not exist yet. **Rejected: wrong address space.** (INFERRED from the
fork-module's guest-side placement; not separately tested.)

**(c) One shared TypeScript module both entries import.**
Delivers **V1 in full** — one implementation, drift structurally impossible,
73-of-105 double-commits become one. Delivers **nothing of V2** and **nothing
of V4**. But: it adds **zero** host surface, needs **zero** ABI motion, and it
is the pattern this codebase has already chosen 31 times (§2.2), including for
the hardest shared pieces — `process-generation-detach.ts`, `vfork-lifetime.ts`,
`process-memory.ts`, `worker-quiescence.ts`, `exec-target.ts`,
`thread-worker-disposition.ts`.

### 4.3 Recommendation

**Stage it: (c) then (a).**

- **K4a — one shared TS lifecycle module.** Move the ~55 duplicated functions
  into `host/src/process-lifecycle.ts`, parameterised by a small host
  capability record: `{ workerAdapter, forkModuleProvider, execByteSource,
  framebufferRelease?, envDecorator?, diagnostics, schedulerTuning }`. Resolve
  each of the 22 drifts in §1.3 by *choosing the correct behaviour* — this is
  not a mechanical delete of one copy. Delete the two `parseShebang` copies per
  §3.5. Expected: **−3,100 to −3,600 lines**, ~360 lines of genuine residue
  per host, and both hosts inherit the safer half of every drift.
- **K4b — the Rust move**, once there is one algorithm to port. The port can
  then be diffed against a single reference implementation instead of two that
  disagree, and the dormant-flag-then-cutover pattern the census recommends
  (`tmpfs.rs`) actually works, because there is one flag, not two.

The honest cost of this recommendation: **K4a is a stop the campaign might
never leave.** A shared TS module is comfortable, and V2/V4 never arrive. That
is a real risk and it is why §8 raises it as a decision rather than absorbing
it.

The honest cost of the alternative: going straight to (a) means simultaneously
(i) choosing correct behaviour for 22 drifts, (ii) inverting sync/async
control flow, (iii) adding ~9 host primitives, and (iv) relocating to a
language whose browser-side behaviour is gated by 5 CI specs that do not touch
fork or exec (§7). The census already calls K4 "the largest single-step
behavior move in the campaign". Doing it in one step, on two divergent copies,
is the version of that move most likely to ship a silent parity regression.

---

## 5. Dependency on K3 — the census is wrong

**VERIFIED. K4 does not depend on K3.**

The entries touch the blocking scheduler only through coarse public methods on
`CentralizedKernelWorker` that return scalars or enums. Neither file names a
single scheduler container, and neither has an `as any` / index escape into
`kernel-worker.ts` privates (VERIFIED: zero hits for
`kernelWorker as any|as unknown|kernelWorker[`).

Coupling classification (call sites, per file):

| category | browser | node |
|---|---|---|
| (a) thin "retry a kernel entry" — survives K3 unchanged | 24 | 24 |
| (b) reads a value to make a lifecycle decision (`startProcessWorkerWhenRunnable` dispositions, `shouldLaunchPendingChild`, `isProcessExecutionActive`/`isExecHandoffActive`) | 15 | 15 |
| (c) mutates scheduler state via a coarse method (`wakeBlockedReaders/Writers`, `notifyPipeReadable`, `killAllBlockedForTeardown`, `failDeferredCloneLaunch`, `settleRetiredChannelListeners`, `signalProcess`) | 9 | 9 |
| (c′) writes scheduler *configuration* directly | **2** | **0** |
| (d) duplicates the scheduler's own blocking | 0 | 0 |

Every (b) site reads a value the kernel-worker derived from **Rust-owned**
`kernel_get_process_state` / `kernel_get_process_exit_signal`
(`kernel-worker.ts:10411-10436`, `:10477-10530`), not from TS sleeper tables.
`"deferred"` — the one disposition that *is* pure scheduler state — is never
branched on by either entry.

The only genuine entanglement is **two lines**: `kernelWorker.usePolling = false`
and `kernelWorker.relistenBatchSize = 1` at `browser…:1333`, `:1338` (browser
only). A unified entry should express those as one field in the host capability
record — worth doing during K4 regardless of K3's timing, since it is exactly
the knob K3 will want to own.

Also VERIFIED: neither entry imports `kernel-entry-gate.ts` or
`kernel-scratch.ts`. The census's "4,061 lines of transport safety /
reentrancy gate" presents a **two-function API** (`retryKernelEntryResult`,
`retryKernelEntryResultForGeneration`, `host/src/kernel-entry-retry.ts:23-45`,
`:57`) and both entries consume it identically — 18 and 6 call sites in *each*
file, exactly equal.

**Recommendation: run K4 first or concurrently with K3.** Doing K4 first means
K3 migrates one call-site set instead of two.

---

## 6. What does `crates/host-native` do instead?

### 6.0 Verdict on the census's standing claim

> *"host-native implements process lifecycle in Rust already… is that a third
> implementation that should become the shared one?"*

- **"implements process lifecycle in Rust already" — VERIFIED, with material gaps.**
- **"could become the shared one for all hosts" — REFUTED as stated.**

Four independent reasons, in order of decisiveness (all VERIFIED):

1. **It cannot compile for the browser, by construction.**
   `crates/host-native/Cargo.toml:8-22` says so outright: *"Wasmtime (and its
   Cranelift backend) does not build for `wasm32-unknown-unknown`, so this
   crate … must always be built and tested for the host target."* Every
   lifecycle function is typed in engine-specific types — `wasmtime::Store<()>`,
   `Linker`, `Module`, `SharedMemory`, `TypedFunc`, `std::thread::JoinHandle`.
   `run_pump` (`guest.rs:9475-9511`) takes **30 `&wasmtime::TypedFunc<…>`
   parameters**; `GuestProcess` (`guest.rs:9022-9086`) holds `module: Module`,
   `memory: SharedMemory`, `thread_handles: HashMap<usize, thread::JoinHandle<()>>`.
   There is no engine-abstract seam to lift. Promoting it is a rewrite against
   an abstraction that does not exist.
2. **It shares nothing with `runtime-core`.** `Cargo.toml:44-72` — deps are
   exactly `wasmtime 48`, `wasm-posix-shared`, `fork-codec`, `anyhow`. All 16
   `runtime_core` / `process_table` / `ProcessTable` mentions in the crate are
   **doc comments** (`guest.rs:10350`, `:11378`, `:11394`, `:11513`;
   `lib.rs:1683`) — zero `use`, zero code paths. It is not a shared core; it is
   a **second consumer of the kernel's Wasm export ABI**.
3. **The part that is genuinely POSIX policy is the part you would want to
   delete, not share** (§6.3).
4. **Its lifecycle coverage is not at parity** (§6.2), and its evidence base
   is thin (§6.1, §6.5).

**The true and useful claim, which should replace it in the census:**
host-native proves the kernel's export contract is **sufficient for a
non-JavaScript host to drive the full process lifecycle in ~1,050 code lines
of handler logic**, with no `runtime-core` linkage and no JavaScript. *The
transferable asset is the contract — and the demonstration that the TS hosts'
~9,100 lines of entry code are not intrinsic — not the code.*

### 6.1 Inventory (VERIFIED)

| file | lines |
|---|---|
| `crates/host-native/src/guest.rs` | 11,965 (6,613 non-comment) — the entire host |
| `crates/host-native/src/lib.rs` | 2,851 — ABI/import-surface probes + the smoke suite (tests at `:316`) |
| `crates/host-native/tests/wasi_module.rs` | 417 — 1 integration test |
| `crates/host-native/Cargo.toml` | 71 |
| `crates/host-native/fixtures/` | 24 hand-written C fixtures + committed `.wasm`/`.wat` |

End to end (`run_guest`, `guest.rs:1018-1438`): build a wasmtime `Engine`,
compute the boot process's `SharedMemory` + `ProcessLayout`
(`compute_guest_memory:2548`), one `Store` for `kernel.wasm`, define
`env.memory` (`:1071`) and 20 `env.host_*` closures (`:1818`), trap the rest
(`:1085`), assert `__abi_version == 44` (`:1089`), take ~30 typed handles to
`kernel_*` exports (`:1094-1250`), enable tmpfs + rootfs overlay
(`:1290-1338`), launch the boot process on its own OS thread
(`launch_process:4906`), then run a single-threaded channel pump
(`run_pump:9475`).

**Correction to the census.** The kernel declares exactly **84** `env.host_*`
function imports (VERIFIED by `wasm-objdump -x` on `local-binaries/kernel.wasm`;
matches `EXPECTED_HOST_IMPORT_COUNT = 84`). host-native implements **20** and
traps **64**. The census's citation `guest.rs:1656` for
`define_unknown_imports_as_traps` is **wrong** — that line is inside
`mod base_image_tests`. The real trap sites are `guest.rs:1085` (kernel
linker), `:4797` (fork-module), `:6955` (main guest), `:8750` (worker guest).
"9 defines" also maps to no single site: `linker.define(` appears 18 times
across four linkers, only one of which (`env.memory`, `:1071`) is on the
kernel linker.

Of the **7 process-lifecycle host imports** the kernel declares, host-native
has 4 real — `host_futex_wake` (`:1846`), `host_proc_read_bytes` (`:1907`),
`host_proc_write_bytes` (`:1923`), `host_waitpid` (`:2441`) — and **3
trapped**: `host_futex_wait`, `host_call_signal_handler`,
`host_sigsuspend_wait`.

### 6.2 Lifecycle coverage, one verdict each (VERIFIED)

| behaviour | verdict |
|---|---|
| **fork** | IMPLEMENTED. `kernel_fork` import (`guest.rs:5560`) → `handle_fork` (`:9812`); child = byte-copied memory + fresh OS thread + fresh Store. **Gap:** a non-fork-instrumented guest's child gets `ForkEntry::ChildPendingStub` (`:10501-10504`) and **never runs any of its copied program** — documented, accepted. |
| **vfork** | IMPLEMENTED with real borrow semantics: the child shares the parent's `SharedMemory` and the parent's channel is deliberately left `STATUS_PENDING` until the child `_exit`s or execs (`:10530-10608`). **Main-thread only** — a worker thread's vfork returns `-ENOSYS` (`:8615-8620`). Non-instrumented vfork silently degrades to COW fork. |
| **clone / threads** | IMPLEMENTED (`:5553` → `:9682-9760`). **Hard limit `RESERVED_THREAD_SLOTS = 16`** (`:104`); exceeding it is a pump-ending `bail!` (`:9719`). Nested `pthread_create` from a worker thread is an unwired gap (`:8735-8740`). |
| **exec / execve** | IMPLEMENTED; `execve` + `execveat` share `handle_exec_common` (`:10806-11079`), full ENOENT/EACCES/ENOEXEC matrix, one-level shebang via the kernel. **A stale stub coexists:** the `kernel_execve` guest import hardcodes `-ENOSYS` (`:5726-5731`) with an out-of-date comment; the live path is `SYS_EXECVE` over the channel. |
| **posix_spawn** | IMPLEMENTED. `SYS_SPAWN` intercepted before marshalling (`:9766-9781`); the blob is decoded by the **kernel**, never re-parsed by the host (`:10077-10442`). |
| **exit** | IMPLEMENTED (`:9628-9680`); per-thread `SYS_exit` → `kernel_thread_exit` with child-tid futex clear. |
| **wait / reap** | IMPLEMENTED **but the POSIX policy lives in the host** — see §6.3. Process-group waits (`pid == 0` or `pid < -1`) return **`-ENOSYS`** (`:2446-2449`). |
| **teardown** | PARTIAL. `reclaim_all_channels` (`:9418-9474`) publishes `CH_TEARDOWN` and joins parked threads; **compute-bound siblings are dropped unjoined** (`:9435-9441`), a documented residual. |
| **signals** | **ABSENT.** `host_call_signal_handler` and `host_sigsuspend_wait` are trapped. No signal delivery exists at all. |

### 6.3 Structurally different, and materially simpler — this is the finding that bears on §4

Same coarse shape: **one OS thread + one wasmtime `Store` + one `Linker` per
Kandelo process** (`launch_process:4906` → `spawn_guest_thread:5104`), exactly
where the TS hosts create one Worker per process; main + up to 16 workers.

But it **sidesteps every concept that makes the TS entries expensive**:

- **No generations.** `grep -i generation` in `guest.rs` returns only
  fork-module doc comments (`:2999`, `:5211`) and references to the *kernel's*
  `exec_generation` (`:1196`, `:10991`). There is no generation type, no
  generation id, no generation ownership. Compare
  `node-kernel-worker-entry.ts`: **221** `generation` hits, an
  `interface ProcessGenerationOwnership` at `:276`,
  `interface ProcessInfo extends ProcessGenerationOwnership` at `:287`, and a
  whole imported module `./process-generation-detach` (`:139`). The browser
  entry has **251** hits. host-native's entire exec transition is two lines
  (`guest.rs:11077-11078`):
  `let old_proc = std::mem::replace(&mut processes[pi], new_proc); reclaim_all_channels(old_proc);`
- **No memory-quiescence fence and no lease retirement.** Neither primitive
  exists in the crate. Quiescence is achieved **structurally**: syscall
  dispatch is synchronous on a single pump thread, so nothing can interleave
  with a `kernel_handle_channel` call. `host_proc_read_bytes` leans on this
  explicitly (`guest.rs:1884-1892`).
- **It does have vfork containment**, and arguably a more honest version:
  `struct VforkParentRelease` (`:9279-9293`) and the
  `vfork_awaiting_child` anti-refork guard (`:9793-9808`), whose comment
  records that the double-fork it prevents was **observed, not hypothetical**.
  The borrow window ends at exactly two sites: child `_exit` (`:9660`) and
  child exec success (`:11073`), both via `resolve_vfork_parent_release`
  (`:9301-9354`).
- Single-threaded pump with a 30-second hard cap (`run_pump:9484`,
  `bail!` at `:9512`); no async, no message passing, no worker protocol.

**Why this matters for §4.** A large share of the ~6,718 duplicated TS lines
— generations, ownership records, quiescence fences, exact-vs-forced lease
retirement — exists because **browser and Node Workers are asynchronous and
`Worker.terminate()` is not an ownership fence**. It is not POSIX complexity;
it is *host-object ownership complexity specific to the Worker model.*
Relocating it to Rust does not dissolve it: a Rust driver would have to
reproduce the same fence protocol through a command list. **This strengthens
the staged recommendation in §4.3** and it also names the real prize — if the
Worker model's fence requirement could be simplified, the code shrinks on
*both* hosts, whatever language it is in.

### 6.4 What it reuses from `runtime-core`: nothing directly

Only through the compiled `kernel.wasm` export surface — **44
`kernel_store.call(…)` sites across 42 distinct `kernel_*` exports**
(`kernel_fork_process`, `kernel_spawn_process`, `kernel_spawn_blob_decode`,
`kernel_publish_spawn_child`, `kernel_exec_target_prepare/_size/_read/_resolve_shebang/_cancel`,
`kernel_spawn_exec_target_prepare`, `kernel_spawn_exec_commit`,
`kernel_exec_commit`, `kernel_remove_process`, `kernel_reap_exited_child`,
`kernel_thread_exit`, `kernel_handle_channel`, …).

**`crates/runtime-core/src/process_table.rs` is a real process table**
(VERIFIED): 4,082 lines, production ending ~2,221 (`mod tests` at `:2222`), so
~1,700 lines of table logic. It owns pid/tid allocation behind a linear,
non-`Clone` capability token (`AllocatedTaskId`, `:42` — only this module can
mint one), parent/child links, per-process fd/OFD tables, zombie/reaping
(`ProcessState::{Running,Stopped,Exited,Limbo}`, `process.rs:441-457`), process
groups and sessions, credentials, and a machine-wide `AdvisoryLockManager`.
`RemoveProcessResult` (`:114`) returns deferred host-side teardown for the
caller to drain — which is precisely what keeps the module host-agnostic.

**Who uses it:** `runtime-core` internally (208 refs) and `crates/kernel` (33
direct + 128 via the `PROCESS_TABLE` alias at `wasm_api.rs:1155`) ≈ 160 kernel
call sites. **`crates/host-native`: zero.** No other crate touches it.
`crates/kernel/src/lib.rs:12` is `pub use runtime_core::*;` — the kernel crate
is a pure wasm-FFI shell over `runtime-core`, where every line of POSIX
semantics lives.

### 6.5 Orchestration vs POSIX decision-making — ~85-90% vs ~10-15%

VERIFIED by line attribution over the lifecycle path.

**Orchestration (~2,700 code lines):** `spawn_guest_thread` `:5104-7269`
(1,355 code lines — one Linker, 29 `func_wrap`s, fork-module instantiation,
externref/GC provenance registries, resume-table binding; essentially zero
POSIX policy); `run_worker_thread` `:8440-8959` (317); `instantiate_fork_module`
`:4592-4905` (159); provenance registries `:2632-3277` (~645);
`define_kernel_host_imports` `:1818-2509` (493 — leaf capabilities, not
decisions); channel plumbing (`stage_raw:9123`, `dispatch_once:9156`,
`marshal_in:11591`, `proc_copy_in/out:557/:578`).

**POSIX decision-making actually made in the host (~250 code lines, four sites):**

1. **`host_waitpid` + `WaitTable`** — ~90 lines, `guest.rs:2441-2547`. The
   significant one. Which child matches `-1`, ECHILD vs EAGAIN vs
   WNOHANG-returns-0, reap ordering, wait-status encoding
   (`encode_wait_status:2510`) — all in host Rust, because the kernel's
   `sys_waitpid` **delegates wholly to this import**. Its own doc comment says
   so.
2. **vfork borrow-window policy** — ~120 lines (`:10530-10608`, `:9279`,
   `:9301`, `:9793-9808`). *When may the parent be released* is a POSIX
   decision made in the host.
3. **exec/spawn rollback + errno matrix** — ~120 lines (`cancel_exec_target:11080`,
   `rollback_spawned_child:11231`,
   `terminate_process_after_failed_exec_commit:11147`).
4. **syscall routing policy in `run_pump`** — ~80 lines of main-vs-non-main
   channel gates for CLONE/FORK/VFORK/EXECVE/EXECVEAT/SPAWN/EXIT
   (`:9628-9910`).

Everything else — exec target resolution, shebang, `X_OK`, set-ID creds,
cloexec, signal reset, `exec_generation`, pid allocation, fd/OFD inheritance,
blocking-retry readiness, the process table — is already in the kernel.

**The architectural reading: that 10-15% is not a design, it is the residue of
places where the kernel export contract is incomplete.** Three of the four
sites would disappear if the kernel owned (i) waitpid selection, (ii) the
vfork release window, and (iii) the exec transaction as a unit. That is an
actionable, separately-schedulable finding — and it is the *opposite* of
"promote the host code".

### 6.6 Its evidence base is thinner than it looks (VERIFIED)

- **54 tests** (41 `lib.rs`, 12 `guest.rs`, 1 integration), **4 `#[ignore]`d**
  — including `smoke_fork_from_thread` (`lib.rs:1990`), a real functional
  blocker labelled *"N1 residual #4a: fork-instrumented worker-thread replay"*.
- **~42 of the 54 silently self-skip green in CI.** The `cargo-workspace` job
  (`prepare-merge.yml:1753-1805`) **never stages `local-binaries/`**, so those
  tests hit `kernel_path_or_skip` (`lib.rs:384-402`) and return green having
  executed no kernel. What actually runs:
  `smoke_channel_wait_notify_handshake`, seven `proc_bytes_tests`, two
  `base_image_tests`, one GC-provenance unit test.
- **Triple-gated** on top of that: `kernel_only: true`
  (`prepare-merge.yml:1725`, `staging-build.yml:868`) means a host-native-only
  diff does not set the `kernel` change-scope and the suite skips entirely;
  staging-build also skips on a `skip-staging-tests` label; prepare-merge only
  runs on `ready-to-ship`. Nothing in `scripts/`, `run.sh`, or `xtask` invokes
  host-native at all.
- **It never boots a real VFS image.** `BaseImage` (`guest.rs:1520-1526`) is
  built in memory from hand-written `BaseEntrySpec` entries
  (`build_base_image:1541`), emitting RTFS-v3 with `archive_count = 0` and no
  symlinks; the doc at `:1518-1520` says explicitly *"never from rootfs.vfs /
  SFFS"*. Its sole consumer, `smoke_reads_base_file` (`lib.rs:740-766`), feeds
  a 3-entry tree. Guests are the 24 committed C fixtures.

**Any claim resting on host-native "running real software" is unsupported.**
Staging `local-binaries/kernel.wasm` + `fork_module32.wasm` into that CI job is
a prerequisite before host-native evidence carries weight in any argument.

## 7. Test coverage — the unification risk list

VERIFIED by config, workflow, and import survey.

### 7.1 The headline: there is a *fourth* lifecycle implementation, in tests

`host/test/centralized-test-helper.ts` (**1,521 lines**) constructs
`CentralizedKernelWorker` directly in the Vitest main process and
**re-implements** `onResolveSpawn` (`:687`), `onSpawn` (`:702`), `onFork`
(`:806`), `onExec` (`:1011`), `onClone` (`:1191`), `onExit` (`:1294`).
**85 of ~330 `host/test` files use it.**

Consequence: `centralized-spawn.test.ts`, `exec.test.ts`,
`vfork-lifecycle-guest.test.ts`, `fork-from-thread.test.ts`, `pthread.test.ts`
and their peers prove **kernel** semantics, not **entry-file** semantics. They
will pass identically before and after unification and give **no signal**.
Only **23** `host/test` files import `../src/node-kernel-host` and therefore
actually run `node-kernel-worker-entry.ts`
(`host/src/node-kernel-host.ts:1317-1340`).

By contrast, **every** Playwright spec that boots a kernel runs the real
browser entry (`apps/browser-demos/pages/test-runner/main.ts:8` →
`host/src/browser-kernel-host.ts:30`, `:431`). The browser has no test-local
twin.

**K4a should absorb the test helper as a third caller of the shared module.**
Leaving it is how a fourth copy survives the unification.

### 7.2 Entry-level assertion ratio (VERIFIED, method stated)

| set | files | test blocks | `expect(` |
|---|---|---|---|
| host/test that really run the node entry | 23 | 68 | 302 |
| Playwright specs (all run the browser entry) | 81 | 176 | 1,071 |
| — of those, lifecycle-touching | 24 | 57 | 458 |

Entry-level ≈ **1 : 2.6 in the browser's favour**; restricted to lifecycle,
≈ 1 : 1. The Node entry then gains a large exclusive integration surface from
the conformance corpus (§7.4).

### 7.3 Browser CI does not gate lifecycle on merge-blocking runs

`.github/workflows/browser-demos-ci.yml` triggers on `host/src/**` — so it
*does* fire on entry-file edits — but runs only five specs:
`boot-current-boundary`, `coi`, `package-deferred-tree-browser`,
`vfs-import-seal-boundary`, `wasm-trap-signal`. **None exercise fork, exec, or
spawn.**

`.github/workflows/prepare-merge.yml:2675-2676` does run the full non-`@slow`
Playwright suite via `scripts/ci-run-test-suite.sh:894-905`, **Chromium only**;
Firefox and WebKit see six non-lifecycle specs. `@slow` (WordPress, Node)
never runs in CI.

### 7.4 The conformance corpus is Node-only

`scripts/run-browser-{posix,libc,sortix}-tests.sh` all exist and all drive the
real browser entry (`scripts/browser-test-runner.ts:88`). **Grepping `run.sh`,
`scripts/ci-run-test-suite.sh` and `.github/workflows/*.yml` for those three
scripts returns zero hits.** They are manual-only, with no `run.sh` verb. The
entire POSIX/libc/sortix process-lifecycle corpus — including sortix `process`
(~24 suites) and `signal` (~32) — runs **only** against the Node entry.

### 7.5 Behaviours covered on Node only — the risk list for unification

1. **Kernel-worker poisoning / fatal** — `node-kernel-fatal.test.ts` (3 live
   tests). No browser equivalent at all.
2. **Destroy / graceful-detach containment** — `kernel-host-destroy.test.ts`
   (3 live tests). No browser equivalent. Note that D17 and D18 above are both
   `performDestroy` drifts, and the browser side of `performDestroy` is
   untested.
3. **Thread exit** — no live test on *either* host; only name-presence in
   `kernel-worker-entry-root-contract.test.ts`.
4. **Process teardown ordering** — `node-process-teardown-ordering.test.ts`,
   Node-only source-grep test, no browser sibling.
5. **Kernel pipe proxy** — `node-kernel-pipe-proxy.test.ts:112`, Node-only.
   (This is where D13's `initReady` divergence lives.)
6. **Shebang / interpreter exec resolution** — six Node test files; **zero
   browser specs mention shebang or interpreter.**
7. **The whole conformance corpus** (§7.4).
8. **Firefox / WebKit lifecycle** — not gated in `prepare-merge`.

### 7.6 The existing parity tests all break by construction

Six structural parity tests match on **literal function names and source-text
ordering** inside the two files:
`kernel-worker-entry-root-contract.test.ts:236` ("keeps the Node and browser
kernel callback roots in parity"), `spawn-host-parity.test.ts` (336 lines),
`fork-replay-host-parity.test.ts`, `fork-externref-host-parity.test.ts`,
`process-generation-detach-host-parity.test.ts:44`,
`host-diagnostic-routing.test.ts`. Plus six more files that read both entries
with `readFileSync` and assert on their text.

`process-generation-detach-host-parity.test.ts:22` even **encodes the D21
naming asymmetry** (`handleTerminate` vs `handleTerminateProcess`) as a
permanent fact.

`spawn-host-parity.test.ts:2-26` states the policy and admits the gap: *"The
Node-side end-to-end coverage lives in `centralized-spawn.test.ts`; the
Browser-side end-to-end coverage rides on the existing shell-demo Playwright
tests… Neither of those would catch a silent removal of the browser `onSpawn`
wire."*

**A unified file fails all twelve mechanically.** They must be **rewritten as
behavioural tests against the shared module before the merge**, not re-pointed
at new string offsets — otherwise the unification deletes the only thing
currently asserting Node/browser symmetry and replaces it with nothing.

### 7.7 Coverage precondition for K4

Before the cutover, at minimum:
- wire `scripts/run-browser-{posix,libc,sortix}-tests.sh` into a `run.sh`
  verb and a CI cell (they already exist and already work);
- add browser specs for kernel-worker poisoning and destroy containment;
- add one live thread-exit test on both hosts;
- convert the six structural parity tests into behavioural tests against the
  shared module.

Anything less means the unification is validated on Node and reasoned about
in the browser, which the validation contract forbids.

---

## 8. NEEDS-DEFER-DECISION

Nothing below was self-deferred. Each is a maintainer call.

### NDD-1 — Is a shared TypeScript module an acceptable terminus for K4?

- **What:** §4.3 recommends K4a (shared TS) before K4b (Rust). K4a delivers V1
  fully and V2/V4 not at all.
- **Why it needs a decision:** if K4b is not committed to, the campaign spends
  its K4 budget on a change that leaves the logic in TypeScript. That may be
  the right trade — 6,718 duplicated lines and 22 live drifts are a bigger
  present harm than V2 is a present good — but it is the maintainer's call,
  not mine.
- **Cost now:** K4a is ~2–3 weeks of careful work with a real coverage
  precondition (§7.7). Choosing straight-to-Rust instead means also inverting
  sync/async control flow and adding ~9 host primitives in the same step.
- **Cost later:** if K4a lands and K4b never does, the ~3,300 surviving lines
  are TS forever, and `host-native` still has no process lifecycle in common
  with the TS hosts.
- **Recommendation:** commit to K4a **with K4b written into the plan as a
  named follow-up item with its own Bar**, so the staging is a schedule, not
  an escape.

### NDD-2 — Can K4b's host contract stay at one import, and can async be sequenced from synchronous Rust?

- **What:** driving the lifecycle from Rust needs host-executed primitives
  (compile-module, create/start/terminate worker, allocate/release memory
  exact-or-forced, post-to-main, await-fence). `crates/fork-module` proves a
  5,362-line Rust subsystem can hide behind **one** import plus a 13-opcode
  `DriveStep` command list executed identically by both hosts (§4.2(a)) — so
  the count is not fixed at nine. But every `DriveStep` opcode is
  **synchronous and in-address-space**, and these primitives are
  **asynchronous and cross-worker**.
- **Why it needs a decision:** the whole V2/V4 case for K4b rests on an
  unproven claim — that an async, rollback-heavy, multi-worker transaction can
  be driven from synchronous Rust exports. That is a probe, not an analogy,
  and the campaign has disproved four inherited floors by re-testing exactly
  this kind of claim.
- **Cost now:** one focused probe (drive a minimal two-await
  create-worker → await-fence → release-lease sequence from a Rust command
  list on both hosts), plus a measurement of which existing host-facing
  concepts K4b would *delete*. Also: find out why the existing
  `kernel_is_fork_child` / `kernel_get_fork_exec_path` launch-instruction seam
  was stubbed to `0` on both hosts.
- **Cost later:** discovering mid-K4b either that the contract grew, or that
  asynchrony makes the command-list shape unworkable — after the code has
  already been relocated.
- **Recommendation:** make the probe and the deletion-measurement K4b's entry
  gate. **STRONG DOUBT stands until both are produced.**

### NDD-3 — Fix the 22 drifts as part of K4, or first, separately?

- **What:** several drifts (D1, D2, D10, D17) are candidate bugs; several
  (D6, D7, D8, D13, D14) are one-host-only features.
- **Why:** bundling behaviour fixes into a 3,000-line deletion makes the diff
  unreviewable and makes a regression unattributable.
- **Cost now:** landing D1/D2/D10/D17 as small, separately-validated fixes
  first adds a few days and needs reproductions.
- **Cost later:** if bundled and something regresses, bisection lands on a
  6,000-line commit.
- **Recommendation:** land the four bug-shaped drifts **first**, separately,
  each with a reproduction; then unify, with the one-host-only features
  resolved explicitly in the unification commit message.

### NDD-4 — The shebang depth-1 gap and the ENOENT errno

- **What:** §3.3. Shebang nesting is 1 level on every host where Linux allows
  4, and preflight exhaustion surfaces as ENOENT.
- **Why:** it is a POSIX/Linux-compat gap that the duplication currently
  hides, and it is severable from K4.
- **Cost now:** a fix in `exec_target.rs` plus tests; small.
- **Cost later:** it stays invisible once the TS copies are deleted, because
  the deletion makes the observable behaviour (depth 1) match the code
  (depth 1) and the gap stops looking like a discrepancy.
- **Recommendation:** record it in `docs/posix-status.md` now, fix it with or
  just after K4's shebang deletion. Do not let the deletion silently close the
  discrepancy without closing the gap.

### NDD-5 — Browser conformance runners are wired into nothing

- **What:** §7.4. Three working browser conformance runners, zero references
  from `run.sh` or CI.
- **Why:** K4's validation depends on them.
- **Cost now:** wiring plus whatever failures they surface.
- **Cost later:** K4 validated on Node and reasoned about in the browser.
- **Recommendation:** wire them before K4 lands. This is provisioning, not
  scope creep (build-docs-and-prs contract).

---

## 9. STRONG DOUBT register

| claim | status |
|---|---|
| "54 functions are duplicated verbatim" (ledger `:68`) | **False as stated.** 13 of 54 are byte-identical; 41 differ; 16 substantively. The *count* is an undercount (≥55 with renamed twins) and the *"verbatim"* is wrong. Correct both in the ledger. |
| "The genuinely host-specific residue is small — constructing a Worker, constructing a `WebAssembly.Memory`, posting a message" (census §3 F1) | **True, and stronger than stated**: those three are *already* abstracted (`worker-adapter.ts`, `process-memory.ts`). Residue ≈ 360 lines plus a host-specific `handleInit` prologue. |
| "K4 depends on K3" (census §10) | **Disproved.** Two lines of coupling. Correct the census. |
| "`parseShebang` exists three times… the Rust one already exists and already works" | **Half right.** The Rust parser works and is already reachable from both TS hosts via `kernel_exec_target_shebang`. But there are 4 `#!` sites plus a 5th predicate, and the *chain* policies disagree — one of them producing ENOENT for a file that exists. |
| "host-native implements process lifecycle in Rust already; it could become the shared one" | **UNVERIFIED — do not rely on it.** host-native has no Workers and is a partial host. Confirm before using it as a K4 argument. |
| Any need to **add host surface** for K4a | **None.** K4a adds zero imports and zero ABI motion. K4b would add host-executed primitives whose count depends on the encoding — possibly one import, on the `fork-module` precedent. See NDD-2; doubt stands until the probe runs. |
| Any **ABI bump** demand from K4 | **None found.** Neither K4a nor the shebang deletion touches syscall numbers, marshalling, channel layout, memory layout, `repr(C)` structs, kernel exports, or VFS image metadata. The shebang change *reuses* an existing export. |
| "Behaviour that genuinely cannot be shared" | **Two boundaries hold**: `forkModuleInitFields` (browser ships wasm32 only) and the browser's `memory_quiescent`-fence requirement (`Worker.terminate()` is not a fence in the browser). Everything else claimed as host-specific is either already abstracted or accidental. The `argv[0]`-keyed Chrome settle delay is a real boundary implemented in a program-specific way — worth revisiting. |

---

## 10. Reproduction notes

- Function extraction and pairwise diffs: scratchpad only, not committed. Regex
  `^(export )?(async )?function NAME`, body terminated by the first column-0 `}`.
- `cargo test -p runtime-core --target aarch64-apple-darwin --lib` — the
  explicit `--target` is required because `.cargo/config.toml` sets
  `[build] target = "wasm32-unknown-unknown"`. Package is `runtime-core`.
- Commit-coupling figure: `git log --since=2026-06-01 --name-only` over the two
  entry paths; 105 commits touched at least one, 73 touched both.
- **Not run:** the Vitest host suites, any Playwright spec, any conformance
  suite. This is a read-only grounding; no behavioural claim here rests on a
  suite that was not executed, and every unexecuted claim is labelled INFERRED.
