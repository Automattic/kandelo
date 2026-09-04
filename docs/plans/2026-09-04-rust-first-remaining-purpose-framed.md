# Rust-First Kernel Campaign — Purpose-Framed Remaining Plan

**Status:** authoritative remaining-work plan as of 2026-09-04.
**Branch:** `brandonpayton/epoll-kernel-route` (PR #1350), plus the
un-integrated `rust-first-phase2/3/4` stack (see §5).
**Supersedes** the scattered ledgers listed in §8 as the single source of
truth for *what is left and why*. Per-slice implementation plans are still
written just-in-time via the writing-plans skill as each slice is executed.

This document exists because agents keep drifting off-purpose (choosing
host-TypeScript solutions, fearing ABI bumps, mistaking already-minimal
seams for work). Read §1 and §2 before proposing or classifying any change.

---

## 1. The purpose (north star)

**Primary:** minimize the required host implementation / host API surface
that *every* host (Node, browser, native wasmtime, and future hosts) must
provide. Fewer, smaller, well-typed host obligations = cheaper portability.

**Secondary:** move logic into Rust, whose typechecking is far deeper than
TypeScript's — so the same logic is written once and verified harder.

**A clarification that prevents a common misreading:** "minimize host
surface" targets *reducible logic*, not device-capability count. The host
must always own real devices — filesystem bytes, sockets, wall-clock,
CSPRNG, GPU/display, worker spawn, the `Atomics.wait` primitive, invoking
guest exports. The campaign does **not** try to delete those. It targets
host code that *interprets the guest ABI* or *reimplements kernel
semantics* — logic that could run in Rust and be shared by all hosts.

---

## 2. The Bar (apply to any piece of host logic)

For any host-side logic on a kernel / syscall / fork / VFS / blocking path,
classify it and act accordingly:

1. **IRREDUCIBLE-HOST** — it needs a capability only the instance-holding
   host can provide: invoking guest wasm exports; minting/holding host
   object references (`externref`); creating a `WebAssembly.Tag`; spawning
   a worker/thread; compiling/instantiating a wasm module; the raw
   `Atomics.wait` blocking primitive; or reaching a real device (FS bytes,
   sockets, clock, CSPRNG, GPU). It stays host — but must be **named and
   justified** in the host-seam list, kept minimal and typed.

2. **MIGRATE-TO-RUST** — reducible logic that does *not* need a host-only
   capability. It **must** move to Rust. Preference order:
   `runtime-core` / `fork-codec` (pure typed logic, reused by every host
   including native) → a co-resident or walrus-injected wasm module (when
   wasm-level ref/table ops are needed) → the kernel. **Host TS is not an
   acceptable home for reducible logic** merely because it is faster to
   write or avoids a rebuild. (This rule was violated when abort-replay was
   first scoped as host-TS coordinator glue.)

3. **DELETE-TWIN** — a redundant JS fallback that runs only when a flag is
   off and is already reimplemented in Rust/injected-wasm. Deleted at the
   flip, not preserved.

4. **ABI is not a constraint right now.** ABI 44 is in development on this
   branch; shape it freely (fork-module exports, host-adapter trait, kernel
   plumbing) to best serve the purpose. Reconcile `abi/snapshot.json` at the
   epoch's end like the rest of the 44 work. The **one heavy lever** is
   guest **re-instrumentation** (it forces a full package rebuild); pull it
   only when logic genuinely cannot move without it, and document why.

5. **Truthful failure over illusion.** A shape we cannot migrate yet is
   gated as a loud, defined `EOPNOTSUPP` (per the census), never faked.

---

## 3. Where the campaign stands (settled — do not re-open)

Phases 0–5 are done; the fork migration (Phase 6) is far along. Concretely:

- **Phase 0–1** (homebrew decouple, crate split): merged.
- **Phase 2** (opaque syscall transport): **done.** The host no longer
  *defines* the guest ABI — it consumes a `cargo xtask dump-abi`-generated
  mirror (`host/src/generated/abi.ts`, source `crates/shared/src/
  host_abi.rs` + `channel_scalar.rs`). `#handleSyscallInner`
  (`kernel-worker.ts:11750`) branches on syscall numbers only to route to
  host capabilities or cross-memory marshaling; semantics fall through to
  `kernel_handle_channel`. (One residue — §4/H4.)
- **Phase 4** (blocking/readiness): **done for readiness computation.** The
  kernel computes poll/select/epoll readiness (`runSelectKernelAttempt`;
  `handleEpollPwait` now dispatches `SYS_EPOLL_PWAIT`,
  `kernel-worker.ts:19594`). The host retains only the wait/retry
  orchestration and the `Atomics.wait` primitive (`#hostFutexWait`,
  `kernel.ts:4855`) — both irreducible. Async completion-channel park
  (`host_wait`/`host_wake`) remains deferred (§4/H-def).
- **Phase 5** (VFS): **done for the `/` authority.** The in-kernel rootfs +
  tmpfs overlay owns path resolution, metadata, permissions, COW, and
  whiteouts (`crates/runtime-core/src/rootfs.rs`, enabled at
  `kernel-worker.ts:4975`). The host `MemoryFileSystem` survives only as the
  `blob_read` byte-store. (Residues — §4/H5.)
- **Phase 6** (fork/exec → Rust): D1–D7 done; the delete-and-gate pass
  landed (unsupported reference kinds fail loud `EOPNOTSUPP`; their JS
  reconstruction deleted). `WASM_POSIX_FORK_MODULE` is still default OFF.
  See §4/F for what remains.

**The host seam is already sharply minimal for fork.** The fork engine
floor (`ForkHostCapabilities` + `ForkLifecycleCapabilities`) is down to
**five** trait methods — `mint_exception_tag`, `provide_unwind_transport_
tag`, `recognize_unwind_transport` (`crates/fork-codec/src/
host_capabilities.rs:192/209/227`), `instantiate_child`, `spawn_thread`
(`:265/279`) — plus the single residual `env.resolve_externref`
(`fork-module-inject/src/main.rs:144`) and two host-owned wasm objects (the
unwind `Tag` and the `(ref null any)` transit table). Every one is
genuinely irreducible. Eight former methods were already collapsed into
injected wasm by item-5/M2.

**The critical structural fact:** the campaign lives on **two divergent
ABI-44 lines that have never been integrated** — see §5.

---

## 4. Remaining work, classified by the Bar

Each item is tagged with its Bar class and grounded in current code.

### Workstream F — Fork line (finish Phase 6 on `epoll-kernel-route`)

- **F1 — Module abort-replay. [MIGRATE-TO-RUST]** *(first fork slice — begins after N0; see §8)*
  With the flag ON, a fork that must abort after capture — a gated reference
  kind (`EOPNOTSUPP`) or a kernel-rejected fork (`childPid < 0`, e.g.
  `ENOMEM`) — currently crashes the parent: `finishModuleTransaction(true)`
  throws `"fork-module path does not own abort replay"`
  (`fork-process-continuation.ts:1314`), and `beginAbortReplay` drives the
  JS `LinkedForkContinuation` (`:683`). Per the Bar, the abort state machine
  + sequencing + resource lifecycle move into `fork-codec`, exposed by
  `fork-module` exports (mirroring `fm_begin_replay`/`fm_finish_replay`/
  `fm_abort`). The host retains only the irreducible seam: the errno/policy
  decision + invoking the guest's already-frozen `wpk_fork_abort_begin`/
  `wpk_fork_abort_end` exports. No guest re-instrument. Scope: simple +
  multi-activation (dlopen) aborts; vfork/borrowed abort stays unsupported
  by existing design (`finishTransaction:1386`); post-seal trigger first
  (mid-capture `ENOMEM` is likely moot on the module path because the
  qualifying predicate excludes arena-exhausting forks — verify).
  Validation: Node + Chromium, plus a parent-corruption fault-injection test
  (the address-space risk) and un-skipping the flag-on gated-abort test the
  delete-and-gate pass left `.skip`.

- **F2 — The irreversible flip + delete twins. [DELETE-TWIN]**
  Flip `WASM_POSIX_FORK_MODULE` default ON (`node-kernel-worker-entry.ts:
  173`; browser + `node-kernel-host.ts` wiring). Delete the flag-off JS
  reconstruction twins already reimplemented in Rust/injected wasm:
  `materializeAllTyped`, `publishTransit`, `decodeExternref`
  (`fork-reference-transaction.ts`) and their gated call sites, plus the
  dead frame/journal engine (`LinkedForkContinuation` frame driving in
  `fork-continuation.ts`). Convert the reference-kind gate fully to
  `admit | raise | loud-fail` (already mostly there). Depends on F1 (so
  abort works when the module path is unconditional). Both-host validation +
  conformance.

- **F3 — Plain-local externref transit seeding → Rust. [MIGRATE-TO-RUST]**
  The unconditional PHASE-B loop `owner.publishExternref(...)`
  (`fork-reference-transaction.ts:1127-1134`) still runs in JS on the module
  path (a directly-held externref carried as a plain local is not covered by
  the module's transit drive step). Move the seeding into the injected
  drive / `fork-codec`, keeping only `resolve_externref` on the host seam.

- **F4 — pthread table-journal reference replay → module. [MIGRATE-TO-RUST]**
  `restoreTableState → materializeAllTyped()` with no module drive
  (`fork-activation-registry.ts:1292-1354`, via `DylinkForkTableReplica`)
  reconstructs references for separately-instantiated pthread workers / later
  table generations entirely in JS. Route it through the module drive like
  the main child path.

- **F5 — funcref-capture floor. [documented boundary]**
  The capture/encode/seal reference seam — including funcref capture via
  `ForkFunctionCatalog.encode` (`fork-activation-registry.ts:463-507`,
  `fork-function-catalog.ts`) — stays in JS. Full elimination needs guest
  **re-instrumentation** (record `(activation, ordinal)` at every funcref
  production site) = the heavy ABI lever. The census proved no shipped
  package needs the *other* gated kinds, so this remains a documented
  boundary + census-gated unsupported set, and its true elimination folds
  into the native backend (§6/N). Do **not** attempt the re-instrument now.

### Workstream H — Small host-surface migrations (independent, per Bar)

- **H1 — `host_debug_log` → narrow sink. [MIGRATE-TO-RUST]** The decode +
  `console.log` (`kernel.ts:1540`) is reducible glue; only a raw stderr sink
  is irreducible.
- **H2 — `host_is_thread_worker` → init-time config. [MIGRATE-TO-RUST]**
  Static wiring data the host knows at init (`kernel.ts:2043`), not a runtime
  capability — belongs in the kernel init payload, removing a per-query
  import.
- **H3 — `host_last_errno` → in-band return. [MIGRATE-TO-RUST]** An ABI
  artifact of smuggling an `Errno` beside a `u32` handle over wasm imports
  (`fork-module/src/host_capabilities.rs:68`); vanishes in the native backend
  (which returns `Result`); can be folded into a richer in-band encoding.
- **H4 — Synthetic network-interface ioctls → Rust. [MIGRATE-TO-RUST]**
  `SIOCGIFHWADDR/IFCONF/IFNAME/IFADDR/IFINDEX` are computed 100% in host TS
  from a TS-only `VIRTUAL_INTERFACES` table and a TS-generated random MAC
  (`kernel-worker.ts:20017`, `:941`, `:3435`), with no kernel involvement —
  reimplemented kernel semantics needing no host capability. Move to
  `runtime-core` constants + a Rust-owned MAC.
- **H5 — `/dev/shm` + `VirtualPlatformIO`/`MemoryFileSystem` deletion.
  [MIGRATE-leaning, capability-gated]** The `/` authority is done, but the
  design-doc Phase 5.3 goal ("delete `MemoryFileSystem` + `VirtualPlatformIO`;
  collapse FS imports to byte leaves") remains. `/dev/shm` as a host
  `MemoryFileSystem` (`node-kernel-worker-entry.ts:1151`) could be subsumed by
  kernel `tmpfs.rs` once SAB-shared `mmap` is handled in Rust. Larger; gated
  on that capability.
- **H-def — Async completion-channel park (`host_wait`/`host_wake`).
  [deferred]** Not implemented anywhere; not on the critical path for
  blocking correctness (today: `Atomics.waitAsync` retry loops +
  `host_futex_wait`). A cleanliness/perf upgrade; land opportunistically.

### Workstream N — Native backend + ABI-44 convergence (see §5, §6)

### Workstream Z — Phase 7 freeze gate (see §7)

---

## 5. The two-line ABI-44 collision (the biggest structural item)

The campaign advanced on two branches that both stamped `ABI_VERSION = 44`
independently:

| Line | Branch(es) | Carries | Native host? |
|---|---|---|---|
| **Fork line** | `epoll-kernel-route` (`ce5b81449`) | Phase 1 `runtime-core` + Phase 5 VFS overlay + Phase 6 fork/exec codec (`fork-codec`, `fork-module`, `fork-module-inject`) | No — `native_sketch.rs` is `ENOSYS` stubs, no wasmtime dep |
| **Transport line** | `phase2 → phase3 → phase4` (linear stack) | Phase 2 opaque transport + Phase 3 `crates/host-native` (wasmtime 35) + Phase 4 native blocking | Yes — real `crates/host-native` |

- Neither line is an ancestor of the other; their `abi/snapshot.json` files
  **both say `44` but differ by 68 lines** — the same epoch integer for two
  different contracts.
- The real native wasmtime host (`crates/host-native`, `guest.rs` channel
  pump) exists **only** on phase3/phase4 and implements ~20 of ~99 `HostIO`
  methods (~78 trap); it runs trivial/pipe/epoll/thread fixtures, **not**
  fork replay.
- The working-tree `docs/abi-versioning.md` still treats **ABI 43** as the
  open epoch and argues against minting 44 — a doc inconsistency to fix.

**N0 — Reconcile into one canonical ABI-44. [IMMEDIATE PRIORITY — do first]**
Pick a single ABI-44 contract; merge/rebase the transport flip (phase2) +
native host (phase3/4) together with the fork line; regenerate one
`abi/snapshot.json` via `scripts/check-abi-version.sh update`; correct
`docs/abi-versioning.md` to reflect 44 as the epoch under development. This is
substantial branch-integration work and is where the user (sole merger)
decides the merge/rebase strategy.

**Decision (2026-09-04, user):** do N0 **before anything else** — before F1
and the rest of the fork work. Rationale: reconciliation defines the single
tree everything else lands on; doing it first avoids re-basing fork work
twice, and it establishes what is genuinely "last remaining." If, after
reconciliation, the fork work (§4/F) is the last remaining feature work, it
is the agreed next focus. The reconciliation strategy itself gets its own
scoping pass + approval before any history-rewriting git operation runs
(§8).

**STATUS 2026-09-04 — N0 rebase DONE (validation pending).** Reconciliation was
executed as two rebases on the isolated branch
`brandonpayton/rust-first-abi44-reconcile` (worktree
`/Users/brandon/kandelo-abi44-reconcile`; `epoll-kernel-route` + the
`pre-m8-fork-flip` tag left intact):
1. **Transport reconciliation** — rebased the 213-commit fork line onto the
   transport tip (`rust-first-phase4-blocking`: opaque transport + native
   `host-native` + blocking). One real conflict (an `ABI_VERSION` doc comment,
   resolved as the superset) + 5 stale-ABI-43 test fixtures (`rerere` replayed).
2. **Rebase onto latest `origin/main`** — pulled in main's 48 build-fix
   commits. Six conflict stops; resolutions were heterogeneous: main superseded
   the fork's coreutils-docs prototype (took main's merged #1352; the fork
   commit dropped as empty), `.gitignore` union, a genuine merge of main's
   #1358 fail-loud kernel resolution with the fork's tar→ZIP test migration,
   and additive unions in the two worker entries + `centralized-test-helper.ts`.
Result: linear history on `origin/main`, `ABI_VERSION = 44` kept (main is still
43 → 44 is unreleased, so this tree IS the canonical 44), union of both lines
verified present, no stray conflict markers.

REMAINING before N0 is truly closed: regenerate ABI artifacts
(`abi/snapshot.json`, `abi.ts`, `abi_constants.h`, `Cargo.lock`) from merged
source; `HOST_RAW_SYSCALLS` classification audit; `centralized-test-helper.ts`
coherence check (deferred redundancy pass); build + validate on the isolated
worktree, provisioned with its own `KANDELO_SOURCE_CACHE_ROOT` so no stale
ABI-44 artifacts leak in from the machine-wide cache. Main added no new
fork-continuation TS (only a #1359 ABI-mismatch guard and a Ctrl-D EOF fix), so
the fork-TS porting inventory (§4/F) is unchanged by the reconciliation: F1
module abort-replay is still the next port, then F3 externref-transit and A5
pthread-table-journal, with the A1 funcref-capture floor needing the guest
re-instrument.

**STATUS 2026-09-04 (later) — N0 CLOSED. Next step = F1 (module abort-replay).**
The reconciled branch was pushed to PR #1350 (force-updated
`origin/brandonpayton/epoll-kernel-route`; pre-reconciliation tip preserved as
tag `pre-m8-fork-flip`; PR retitled + described). Validation done at the agreed
level ("decision B" — sufficient-for-reconciliation, defer heavy end-to-end):
- Merged Rust compiles; full Rust suite **2604 pass / 0 fail** (33 binaries).
- One failure found + fixed (`bce056261`): the `WPK_FORK_MODULE_STATE_RECORD_KINDS`
  count assertion was stale at 13 vs the real 14 (JOURNAL_IMAGE #14) — a
  PRE-EXISTING fork-line bug, not a merge artifact, surfaced by running the suite.
- Native `host-native` (wasmtime) crate compiles + tests pass.
- ABI 44 snapshot regenerates byte-identical from merged source (coherent).
- `HOST_RAW_SYSCALLS` × in-kernel-VFS audit: safe (byte-serving FS syscalls are
  RAW → stay off the opaque-record fast-path → keep the blob_read/EAGAIN path).
- `host/src` TypeScript typechecks with zero errors (worker-entry + kernel-worker
  unions are type-clean).
DEFERRED to the next build (decision B — run when F1 needs a build anyway): host
Vitest behavior + the `centralized-test-helper.ts` coherence check, and browser
Playwright. These need a full cold ABI-44 package projection on the isolated
`KANDELO_SOURCE_CACHE_ROOT` (~1-2h), not worth the wall-clock purely to reconfirm
a merge that already passes Rust tests + typecheck.
So the campaign sequence now advances to **F1 module abort-replay** on this
reconciled tree (worktree `/Users/brandon/kandelo-abi44-reconcile`, branch
`brandonpayton/rust-first-abi44-reconcile` = PR #1350 content), per §4/F and §8.

---

## 6. Native wasmtime backend (campaign item 7 / Phase 3 completion)

Depends on N0 (native host present on the integrated tree).

- **N1 — Real native backend.** Turn `native_sketch.rs`'s `ENOSYS` stubs
  into a working `ForkHostCapabilities`/`ForkLifecycleCapabilities` impl:
  hold `Rooted<ExternRef>/AnyRef/Func/Tag/Instance` in a `wasmtime::Store`
  with `RootScope`-based generations, `Instance::new` for children,
  `std::thread::spawn` for replay; add the `wasmtime = "35"` dep to the fork
  line (it has none today). Extend `crates/host-native` to implement the full
  `HostIO`/`HostCapabilities` surface (the ~78 currently-trapped methods) and
  wire fork replay through it. This is also the natural home for the *true*
  elimination of the F5 funcref-capture floor and the H3 errno artifact —
  native host code holds/derefs/compares refs directly via the Store, with no
  instrumentation shadows and no JS WeakMap.
- **N2 — ABI-44 finalization.** Confirm `ABI_VERSION` + regenerated snapshot
  in one commit; rebuild all binaries; cut the immutable `binaries-abi-v44`
  release + `index.toml` ledger via the Prepare-Merge / post-merge-activation
  flow (`docs/abi-versioning.md`).

---

## 7. Phase 7 — freeze gate (last; depends on §5, §6)

Prove Decision #4: the **same** `kernel.wasm` boots under browser + Node +
native wasmtime — the platform boundary is not secretly JavaScript-shaped.

- **Z1** — Extend the host-adapter manifest: ABI 44, capability-discovery
  bitset, resource limits, channel checksum.
- **Z2** — Same image boots on all three hosts.
- **Z3** — Verify the seven completion criteria (TS out of the dispatch
  path; a guest-ABI reshape needs zero `host/src` edits unless it adds a host
  capability; three hosts share `runtime-core`; Node/browser parity at every
  green commit; unsupported capabilities fail with a defined error; perf
  claims backed by before/after benchmarks on Node **and** browser; the
  record decoder is fuzzed + property-tested).
- **Z4** — Curate history; rebase-merge (contributor attribution preserved).

---

## 8. Sequence and dependencies

Per the 2026-09-04 decision, the work is **serial**, not two parallel tracks:
reconcile first, establish the single tree, then everything else lands on it.

```
N0 (reconcile the two ABI-44 lines into one canonical tree)   ← DO FIRST
     │  (its own scoping pass + approved strategy before any
     │   history-rewriting git op; user is sole merger)
     ▼
Fork work on the reconciled tree (if it is the last remaining feature work):
     F1 (abort-replay) → F2 (flip + delete twins) → F3 (externref transit)
                                                   → F4 (pthread table-journal)
     After F1 → F2 the module path is the default and fork is dogfoodable
     (`./run.sh browser` IS the campaign). F5 = documented boundary (folds
     into N1). H1–H4 = independent small wins, any time.
     ▼
N1 (real native wasmtime backend — completes the host-native impl; also the
     true home for the F5 funcref floor + H3 errno artifact)
     ▼
N2 (ABI-44 finalization: snapshot + ABI_VERSION in one commit; rebuild all
     binaries; cut binaries-abi-v44 release; fix docs/abi-versioning.md)
     ▼
Z1..Z4 (Phase 7 freeze gate: manifest extension; same kernel.wasm on
     browser + Node + native; seven completion criteria; benchmarks;
     curate history → rebase-merge)
```

**Why N0 first:** reconciliation defines the single tree every later slice
lands on. Doing fork work first would force re-basing it onto the reconciled
tree later. Reconciliation also reveals what is genuinely "last remaining."

Fork/exec is the **severable leaf**: if native fork replay (N1) stalls, the
rest (transport + VFS + blocking + native host + ABI 44 + freeze) can still
land without "fork is Rust-directed," per the design doc.

**N0 is not yet a mechanical plan.** It needs its own scoping pass — map the
actual content divergence between the fork line and the transport line,
locate the 68-line snapshot conflict, and choose merge vs. rebase vs.
re-sequence — presented for approval before any branch surgery. That scoping
is the immediate next step.

---

## 9. This supersedes

For remaining-work framing, this document supersedes (does not delete —
they remain as historical ledgers):

- `.superpowers/sdd/2026-09-01-phase6-fork-exec/*` (PLAN, ITEMS-4-7-PLAN,
  MINIMIZE-HOST-SURFACE-PLAN)
- `.superpowers/sdd/2026-09-03-fork-reference-into-wasm/ROADMAP.md` (the
  M1–M8 slices + the two SCOPE DECISION blocks)
- `docs/superpowers/plans/2026-09-04-fork-references-delete-and-gate.md`
  (executed; its residue is F5)

The master design remains `docs/plans/2026-08-25-rust-first-runtime-
design.md`; this plan is the current, purpose-framed view of what is left.
