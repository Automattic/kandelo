# Rust-first campaign — live status

**Purpose:** one file that answers "where are we" after a crash or context loss.
Update it as work lands. The reasoning lives in
`docs/plans/2026-09-09-rust-first-value-plan.md`; this is the index.

**Branch:** local `brandonpayton/rust-first-abi44-reconcile` → remote
`brandonpayton/epoll-kernel-route` (PR #1350). **Push forward-only. Never
amend, never force-push. The maintainer is the sole merger.**

**Last pushed:** (see git) (2026-09-10)

## Ledger — the number that judges this campaign

`9638a2023..bb9fe63ec`: in-scope TS **+474** (890 added / 416 removed),
Rust **+21,211** (16,678 production / 4,533 test).

**TypeScript is still net POSITIVE. That is the campaign's central open risk.**
If work stopped now the repo would be strictly worse than at the start: the same
TypeScript, plus a large parallel Rust implementation. All the value is
backloaded into cutovers.

Measure with `scripts/migration-ledger.sh --step <base> <tip>`. It is a
measurement, not a gate; line count is a poor metric but a useful hint.

## The rule that governs everything from 2026-09-10

**Cutover is part of the item.** An item is done when the Rust *runs* and the
superseded TypeScript is *deleted*. Landing tested-but-dormant Rust is a failed
item, not a partial success.

Agents work in separate git worktrees, so two agents editing
`crates/kernel/src/wasm_api.rs` (the repo's only export surface, ~308 exports)
is a **merge** problem, not a correctness problem. Do not contort a change to
avoid a contested file. The coordinator resolves at merge.

## Standing constraints

- **ABI 44 for the whole campaign. No further `ABI_VERSION` bumps.** Regenerate
  `abi/snapshot.json` only; a gate complaining the snapshot moved without a bump
  is expected within the epoch — report it, never silence it.
- **Never self-defer.** Land the safe part, then report NEEDS-DEFER-DECISION
  with what / why / cost-now / cost-later / recommendation. Deferrals are the
  maintainer's call.
- **Generic-first (BINDING).** Kandelo is a generically applicable POSIX kernel.
  Never shape behaviour to what today's packages or demos exercise.
- **Browser validation:** one consolidated pass at the end of Tier 2 and again
  after Tier 3, plus the maintainer's own manual check of the web app before
  merge. Agents state what is unproven instead of fighting provisioning.
- **Curation is on hold** — the maintainer wants to cross-examine the work and
  the repo state before agreeing a curated commit set. Do not squash.

## Status by item

| Item | State | Notes |
|---|---|---|
| K0 probes | **DONE** | Disproved the E1 GC blockers and the V8 `epoll_pwait` crash |
| K13a | **DONE** | Dead export deletion |
| K1 / K1b | **DONE** (step 5 owed) | JSON + ABI stamp completes V3 |
| K10 | **PARTIAL; I6 RUNNING** | I1/I2/I3/I7 landed; I6 re-examines its own fixtures gate |
| K14 | **DONE** | |
| K5 | **Rust landed 2026-09-10; NOT cut over** | Placement adjudicated; re-cut as I6a + I6b. See the correction below |
| K8 | **incr 1 done; incr 2 running** | Kernel parses a real VFS image; boot flip in progress |
| K3 | **0a/0b/1/2 done; epoll cutover owed** | `wait_queue.rs` + `wait_shadow.rs` dormant |
| K7 | **Rust landed; cutover MIS-SCOPED (confirmed twice)** | SysV re-cut RUNNING; see "K7 cutover" below |
| K12 | **DONE (scope corrected)** | GC elimination disproved; `fm_*` 72 → 70 |
| K11 | **PARTIAL** | 1 of 4 landed; 2/3/4 need a second pass (now unblocked) |
| K9 | **RUNNING** | Handle-only host contract, 83 → ~67 |
| K4 | **K4a tranches 1-2 merged; continuation RUNNING** | 39 pairs / ~3,430 lines left; K4b probe PASS |
| K6 | **RUNNING** | Marshalling: SysV IPC, mqueue, sendmsg/recvmsg, ifconf |
| K13b | **NOT STARTED** | Export cull |

## Host import surface

**83**, measured on a freshly built kernel (`wasm-objdump -x
local-binaries/kernel.wasm | grep -o "env\.host_[a-z_0-9]*" | sort -u | wc -l`).
84 → 85 (K8's `host_image_read`) → 83 (K3 0b removed two dead ones).

**One new import is sanctioned**, gated on measurement: cross-memory
`host_proc_compare_bytes`, the third member of the read/write family. See §2w of
the value plan for why it protects the abstraction.

## CORRECTION — K5 was recorded as COMPLETE and was not

§2p of the value plan claimed "K5 — COMPLETE … `cargo test -p dylink` 72/72".
**Only the docs commit had been cherry-picked onto the branch. `crates/dylink`
did not exist here at all**; the code sat in the agent's worktree. The tests
genuinely passed — in a tree that was never merged.

Found on 2026-09-10 by the K5-I7 agent, which could not cut over to a crate that
was not present. Fixed the same day: nine commits merged
(`f622651b1`…`ababb6eee`), `cargo test -p dylink` green on the branch.

**Coordinator error, and the lesson generalizes: recording an outcome is not
landing it.** After every agent merge, verify the *artifact* exists on the
branch — not just that a docs commit describing it does.

## Deletion debt — every line here is owed, with an owner

| Owner | Target | Lines |
|---|---|---|
| K5 I6a/I6b | `dylink.ts` + `dylink-fork-archive.ts` | 6,340 |
| K10 I6 | `wasi-shim.ts` | 1,649 |
| K8 i2 | `vfs/rootfs-manifest.ts` | 354 |
| K7 re-cut (1) | SysV half of `kernel-worker.ts` | ~263 |
| K7 re-cut (2,3) | rest of the mapping subsystem | ~3,300 |
| K3-7.7 | epoll mirror in `kernel-worker.ts` | unmeasured |

## K7 cutover — mis-scoped, and the finding is worth more than the item

The cutover agent could not delete the TypeScript, and this is **not** a
deferral: the deletion is not performable as scoped.

`SharedMappingTable` covers about two thirds of the ~3,600-line TypeScript
subsystem. **~1,203 lines have no Rust counterpart at all:**
`handleSharedMappingsAfterFileSyscall` and its per-syscall range policy, the
pre-syscall flush, `findSharedMmapBackingForFd` + `sharedMmapFdCache`, the
path-keyed lookups, the `reload*` family, and the mmap-from-file registration
path. That code opens by reading the very containers the cutover was meant to
delete, and it implements POSIX `MAP_SHARED` fd/mapping coherence, so it can be
neither deleted nor dropped. **Wiring entry points could never have finished
this cutover.**

It is a **dispatch/policy gap, not a primitive gap** — `invalidate_range`,
`flush_range`, `revalidate` and `ensure_range_loaded` all exist.

**Why it was missed:** the cutover contract written on `SharedMappingTable` was
accurate about what it did and *silent* about what it did not. **Silence in a
work contract reads as completeness.** Three concrete errors were corrected in
place: `process_memory_len` is a sixth host-sourced value but an *entry-point
argument*, not an import (the host grows guest memory after the kernel returns
from `mmap`, so it already holds the value); `retain_handle`/fd-writeback were
described as existing and did not, and now refuse with `ENOSYS` rather than
hand out a handle the kernel may close; and the perf note left the copy
unbounded.

**The performance doubt is narrower than filed.** Both Rust and TypeScript skip
a mapping whose backing has `ref_count <= 1` and is not stale, so the copy is
confined to a large writable `MAP_SHARED` **with a live peer**. A general
syscall benchmark exercises only the early-out — a true result that says
nothing about the copy. Closing this needs a *targeted* shared-mapping
benchmark, not a general suite. **`host_proc_compare_bytes` was therefore not
needed and not added**; the sanctioned import remains unspent.

**Re-cut as three items:**
1. **SysV half, now** — separable, complete, ~263 TypeScript lines, two
   containers, and the one part with a performance *gain*. Design the boundary
   early-out trap first: `shmMappings.size` is half a predicate the host would
   otherwise lose.
2. **Write the coherence layer in Rust**, sized as policy rather than as
   plumbing.
3. **Anon + file cutover**, gated on that targeted benchmark.

## In-scope test failures — coordinator owns these

| Failure | State |
|---|---|
| `zip::real_man_zip_cross_checks_members` | **FIXED** — asserted a locally built binary's byte count; now asserts the archive's own `uncompressed_size`, which is strictly stronger |
| `kernel-scratch-contract` — pointer-role | **FIXED** — `kernel_spawn_blob_decode` used `buf_cap`; the repo uses `_capacity` 13× and `_len` 74×, so the guard was right and the code had drifted |
| `kernel-scratch-contract` — spawn symbols | **FIXED** — the guard demanded the host reference spawn limits the kernel owns under ABI 44; satisfying it would have pushed an authority back out of the kernel to make a test pass |
| `kernel-scratch-contract` — unreviewed memory authority | **53 → 16**, see below |
| `vfs-image-wasm-policy` | **FIXED** — the rejection message hardcoded "ABI 43" while `ABI_VERSION` is 44; the test was right and the message was stale. 13/13 |

### The unreviewed-memory-authority guard: 53 → 16, and why the rest waits

Two genuine scope gaps accounted for 37 of the 53, and neither fix weakens the
guard:

- `isOrdinaryTestHarness` matched `/test/`, the TypeScript layout. Rust crates
  use Cargo's `tests/`, and the `.mts` generators that build their `.wasm`
  inputs sit in `testdata/`. Those are test infrastructure by exactly the same
  argument as `host/test/`; the match missed them purely on directory spelling.
  Recognizing both applies **one rule across two language conventions** rather
  than granting Rust an exemption.
- Probe harnesses under `docs/plans/probes/` are recorded measurements, not
  runtime sources. They are run by hand to prove or disprove a claim about an
  engine and never enter the product. Auditing them made the contract depend on
  which experiments happened to be committed.

`wasm-memory-write-audit.test.ts`, which shares the scope function, still passes
87/87 — the narrowing did not blind it.

**The remaining 16 are real and are all in `host/src`**: K8's `loadImage`
direct export use, the spawn-blob decode scratch leases, the opaque-transport
`#handleRecordSyscall` leases, the `host_image_read` destination factory calls,
and fork-module/trampoline instantiation. Each is a new view into kernel memory
created by this campaign, and the guard is correctly demanding review of each.

**Deliberately deferred to the tier-end reconciliation, not forgotten.** Those
sites live in `kernel-worker.ts` and `kernel.ts`, which K9, K4 and K8-i2 are
actively rewriting. Reviewing and allowlisting them now guarantees doing it
twice. **Owner: coordinator, at the end of Tier 2.**

## Stale ABI epochs in user-facing messages — 30 sites, partially swept

Fixing `vfs-image-wasm-policy` exposed a class defect: **`host/src` contains 30
error-message strings that name "ABI 43" as a literal**, plus 13 comments. The
ABI is 44. A stale-artifact rejection therefore tells whoever reads it that the
artifact belongs to an epoch nobody is running — the opposite of the
truthful-failure contract, in the very message whose whole job is to be
truthful about staleness.

**Fixed so far:** `constants.ts`'s
`contains ABI <n> wasm-fork-instrument metadata, imports, or exports` now reads
the epoch from `ABI_VERSION`, and its one test dependent in
`wasm-binary-parse.test.ts` follows.

**Not a mechanical sweep, deliberately.** Some of the remaining occurrences
genuinely describe what **ABI 43** did — e.g. "ABI 43 instrumentation lowers
every valid occurrence to the trampoline" is a historical statement and is
still true. Replacing those with the live version would *introduce* falsehoods
while claiming to remove them. Each site needs a judgment about whether it
names the epoch being validated (dynamic) or the epoch that introduced a
behaviour (historical).

**Owner: coordinator, tier-end reconciliation**, alongside the 16
memory-authority sites — and for the same reason: the files
(`constants.ts`, `dylink.ts`, `kernel-worker.ts`, `worker-main.ts`) are being
rewritten by five agents right now.

**Unverified here:** `host/test/wasm-binary-parse.test.ts` could not be run in
this worktree — it fails at *collection*, before reaching any assertion,
because `programs/wasm32/spidermonkey-node.wasm` is not built. That is
fresh-worktree provisioning, not a result. The production-side change is proven
by `vfs-image-wasm-policy` at 13/13.

## The fifth silent-success defect — a deletion gate pre-armed to lie

Found by the K5 cutover agent, 2026-09-10, and it is the most dangerous shape
this campaign has met.

**All 18 real-`dlopen` end-to-end tests skip unless `local-binaries/kernel.wasm`
exists — and `./run.sh setup` never creates it.** A fresh worktree therefore
reports `3 passed | 3 skipped`, **exit 0**, alongside 100 green unit tests.

An agent told to "run the dlopen suites before deleting `dylink.ts`" would have
seen green and **proven nothing**. The gate guarding a 6,340-line deletion was
armed to pass by default.

The agent provisioned properly — kernel via `install-local-artifact`,
`crates/fork-module/build-wasm.sh`, and `npm --prefix host install` (`vitest` is
a `host/` devDependency and the root has no workspaces) — and recorded the real
baseline: **116 passed / 2 failed of 118**, the two being the tracked
pre-existing pthread `__wpk_fork_frame_reserve` gap. **That number, not
"green", is what the cutover must show.**

This is the fifth silent-success defect: a rebuild that did not rebuild, two
test gates scoring a skip as a pass, `build-musl.sh` exiting 0 on failure, and
now a suite that skips its entire real-behaviour half unless an artifact nobody
builds happens to be present. **The pattern is consistent enough to be a
standing suspicion: when a gate reports success, check that it ran.**

## K5's placement question — adjudicated, do not re-derive

The planner is a pure Rust library with no wire format and no wasm entry point,
so on JavaScript hosts **nothing could call it**. That, not scope, is what held
the deletion — the item was scoped as I7 but is really I2–I7.

- **(β) fold into `crates/fork-module` — REFUTED, and the grounding had
  *recommended* it.** Fork-module instantiates under
  `if (hasForkInstrumentation)` (`worker-main.ts:3473`), while
  `buildDlopenImports`'s call site (`:5533`) is in the **non**-instrumented
  branch. Folding would remove `dlopen` from every uninstrumented process — and
  **no in-repo artifact would catch it**, because PHP is the only runtime-
  `dlopen` consumer and PHP *is* instrumented. A textbook generic-first
  violation, invisible to the test suite.
- **(ζ) link into the kernel — refuted.** The kernel reaches process memory only
  through `HostIO::process_memory_len` and channel scratch; both the `.so` image
  and the KFLA archive live in guest memory.
- **(α) standalone module — forced**, and cleaner than assumed: **zero imports,
  not even `env.memory`.** Cost measured rather than estimated: **14 integration
  points** (build 3, freshness 2, projection 4, hosts 5 — four *independent*
  browser registrations that fail only in a SourceOnly build).
  `crates/wasi-module` is the negative example: correct build script and stamp,
  zero pipeline.

**Re-cut as I6a** (module crate + the 14 pipeline points, provable by
`verify-fresh` plus a browser boot) **and I6b** (KFLA encoder, TS
driver/executor, `worker-main` rewire, deletion, browser pass).

## K4 — a real browser defect fixed, and the grounding blamed the wrong host

**Re-measuring corrected the census.** At this base the two worker entries are
**13 identical / 3 cosmetic / 39 differing**, not the 13/17/16 the grounding
recorded a day earlier. **71% of pairs differ**, holding 3,430 lines — the drift
is moving faster than the document describing it.

**K4b probe: PASS.** A 220-line `no_std` Rust cdylib — 2,017 bytes, `env.memory`
its only import — drove `CREATE_WORKER → AWAIT_FENCE → RELEASE_LEASE` plus a
rollback branch it chose itself, from a Node harness with real Workers, a real
`memory_quiescent` fence, and a simulated reentrancy refusal. **Asynchrony is
not the blocker.** The grounding's "abandoned seam" warning was a misreading:
`kernel_is_fork_child` is a *guest→host CRT import*, killed by a worker-boundary
refactor, not by async. STRONG DOUBT **relaxed, not lifted** — the pump has
never run in a browser.

**One boundary explained three "bugs", and the grounding blamed the wrong host.**
Measured: `await worker.terminate()` **is** an ownership fence on Node (a thread
parked in `Atomics.wait` does not resume; a control proves `notify` wakes a live
one) and **is not** in the browser. That single fact accounts for D1, D10 and
D16 — **none of which is a Node bug**, as the grounding had it.

**D17 is the one real defect, and it is the browser's:** a VM interrupt timer
left armed across lease release could `Atomics.store` into a handed-back
backing. **Fixed.** D2: both hosts already reported exactly once, but the
browser's guarantee depended on statement adjacency; it now uses Node's explicit
`reportedExits`. A Node comment justifying an exact release with "was never
started" was also false — it tests `preparedTransferred`.

**NEEDS-DEFER-DECISION (NDD-K4-1): `parseShebang` is not deletable on this
plan's terms.** `kernel_exec_target_shebang` needs a *prepared target token*;
the spawn preflight has none and exists to be side-effect-free (POSIX requires
`file_actions` run exactly once). Closing it needs a prepare/cancel pair, a new
bytes-oriented export (ABI-adjacent), or folding into the observable-depth-1
item. **Agent recommends the third and did not delete them.**

**Ledger: +67 TS** (625 added / 558 removed) — honest, with the owner named: the
shared module is 464 lines paid once, 488 left the entries, 60 left
`worker-main.ts`; the remaining 39 differing pairs are K4a's outstanding work.

**Browser NOT validated** — see the cache race below.

## Concurrent agents race on the shared build cache — use an isolated root

K4 lost **three consecutive** `./run.sh prepare-browser` attempts to this, and
K11 reported several suites as flaky that passed when run alone. Every worktree
on this machine defaults to `$HOME/.cache/kandelo/source-only`, so six
concurrent agents mutate one `program-packages.json` and one product tree.

**These failures look exactly like real defects.** That is the danger: an agent
reports a racy provisioning failure as a finding, or worse, treats a corrupted
product tree as evidence.

The repo already has the fix — `KANDELO_SOURCE_CACHE_ROOT` (documented at
`run.sh:25`, implemented at `tools/xtask/src/local_build.rs:406`). Every agent
brief from now on sets it:

```
export KANDELO_SOURCE_CACHE_ROOT=/tmp/kandelo-cache-<item>
```

The cost is a cold first build. That is the right trade for anything doing
browser provisioning or a full `setup`.

## Browser validation debt — for the tier-end consolidated pass

Per the maintainer's ruling, browser runs as **one consolidated pass at the end
of Tier 2 and again after Tier 3**, plus their own manual check of the web app
before merge. Agents no longer fight browser provisioning; they name what is
unproven. This is that list.

| Change | Unproven |
|---|---|
| K4 **D17 fix** | A browser VM interrupt timer left armed across lease release could `Atomics.store` into a handed-back backing. Fixed and reasoned about; **not run in a browser.** |
| K4 **D2 change** | Browser once-only process-exit now uses explicit `reportedExits` instead of relying on statement adjacency. |
| K4 lifecycle paths | Every browser path through the new `process-lifecycle.ts`. |
| K8 **MITM CA write** | Browser-only; ordering changes if the boot flip lands. |
| K11 pieces 2/3/4 | Not attempted — blocked at the time on file ownership. |
| K10 I4/I5 | WASI browser cutover, if I6 needs it. |
| K5 | Entirely unproven — that agent changed zero TypeScript. |

**Note K4's browser gap was caused by the cache race, not by the change.** Three
`prepare-browser` attempts failed on `shell/wasm32`, which blocks every browser
product; once from a sibling's concurrent mutation of
`packages/registry/program-packages.json` mid-digest. With
`KANDELO_SOURCE_CACHE_ROOT` now standard in every brief, the tier-end pass
should not hit it.

## NDD-K4-1 `parseShebang` — RULED (2026-09-10)

**Maintainer's ruling:** *"pursue whatever is first POSIX compliant and useful
and favor reuse where possible."*

Applied, that splits the question in two, and the cheap half was available all
along:

**Now — share the duplicate.** The two copies
(`browser-kernel-worker-entry.ts:311`, `node-kernel-worker-entry.ts:947`) are
**byte-identical**; verified by diff. The only difference in the surrounding
pair is the caller's read function — `readExecFileFromFs` in the browser,
`resolveExec` on Node. Moving `parseShebang` and `MAX_SHEBANG_DEPTH` into the
shared `process-lifecycle.ts` is therefore **zero behaviour change, zero new
exports, zero ABI surface, no new state** — the purest available reuse. Assigned
to the K4a continuation.

**Later — the kernel-owning question stays open, unchanged.**
`kernel_exec_target_shebang(owner_pid, token, out_ptr, out_len)` needs a
*prepared target token*; the spawn preflight has none and must remain
side-effect-free, because POSIX requires `file_actions` run exactly once. The
three costed options stand (prepare/cancel pair, a new bytes-oriented export, or
folding into the observable-depth-1 item), and the recommendation remains the
third.

**Why sharing first is strictly better than choosing among those three today:**
it removes the duplication immediately at no risk, and leaves **one** call site
to repoint instead of two when the kernel does take ownership. Nothing is
foreclosed. Under the maintainer's test — POSIX-correct first, useful, favour
reuse — a prepare/cancel pair would also have been POSIX-defensible but
introduces lifecycle state that can leak, and a new bytes-oriented export would
add a second way to do something the kernel can already do. Reuse wins on both
counts.

## Open decisions for the maintainer

1. K3 §11.2 `usePolling` deletion.
2. K3 §11.3 two epoll POSIX gaps — interest-list inheritance across `fork`, OFD
   keying. Ruling: **fix if straightforward, else log explicitly and defer.**
3. K11's second pass over pieces 2/3/4 (~2,300 lines) — now unblocked by the
   worktree ruling.
4. K5's remaining cutover shape (I6a module + 14 pipeline points, I6b rewire +
   delete). **Placement is already adjudicated — do not re-derive it.**

## Standing instruction for the end of the campaign

When every tier closes, **do not stop**: run a fresh census over the same scope
and ask again what should be migrated, reduced, or removed — then start on
whatever it finds. The maintainer asked for this explicitly on 2026-09-10.

## Traps this campaign has already paid for

- **`cargo run -p xtask` needs a host target** or it builds xtask for wasm32 and
  dies in `zstd-sys`/`ring`. Use `scripts/xtask.sh`.
- **`./run.sh rebuild kernel` does NOT repoint ambient
  `local-binaries/kernel.wasm`.** Install it with `build-deps …
  install-local-artifact` (needs `WASM_POSIX_LOCAL_INSTALL_SOURCE` **and**
  `WASM_POSIX_LOCAL_INSTALL_SESSION`).
- **Run Vitest inside `./scripts/dev-shell.sh`** or the SDK is absent from PATH
  and ~80 unrelated failures appear.
- **A base reproduction shows authorship, not innocence** — a defect may have
  entered hours earlier. One of the coordinator's own was caught this way.
- **Never `git add -A docs/plans/`** — it sweeps other agents' in-progress files.
- **Twelve inherited "floors" have been disproved, six of them the
  coordinator's.** Measure rather than inherit.
