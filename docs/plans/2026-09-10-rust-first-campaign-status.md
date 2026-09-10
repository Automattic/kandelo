# Rust-first campaign — live status

**Purpose:** one file that answers "where are we" after a crash or context loss.
Update it as work lands. The reasoning lives in
`docs/plans/2026-09-09-rust-first-value-plan.md`; this is the index.

**Branch:** local `brandonpayton/rust-first-abi44-reconcile` → remote
`brandonpayton/epoll-kernel-route` (PR #1350). **Push forward-only. Never
amend, never force-push. The maintainer is the sole merger.**

**Last pushed:** `b5db3ca38` (2026-09-10)

## Ledger — the number that judges this campaign

`9638a2023..bb9fe63ec`: in-scope TS **+474** (890 added / 416 removed),
Rust **+21,211** (16,678 production / 4,533 test). K4a's continuation then
took TS **-80** over `49c0718ee..51f23b85d`.
`9638a2023..d72190d0e`: in-scope TS **−2,397** (5,388 added / 7,785 removed),
Rust **+26,134** (21,565 production / 4,569 test).

**TypeScript is NEGATIVE as of 2026-09-10.** It stood at **+550** before the
cutover round and moved 2,947 lines in one merge sequence: K6 marshalling
(−1,978), K10 I6 (`wasi-shim.ts`, −1,055), K7 SysV (−267), plus two small
census deletions (−86). The campaign no longer leaves the repo worse than it
found it if it stops here.

**Host imports: 83 → 75** (K9). Kernel exports **320 → 199** (K6 removed 5;
K13b withdrew 121), measured on the built `kandelo_kernel.wasm` rather than on
the source.
**Host imports: 83 → 76.** **Kernel exports: 309 → 320.** Both measured on a
freshly built artifact after every merge, not carried over from an agent report.

**Why 76 and not K9's 75 — accounted for, not rounded away.** K9 reached 75
partly by deleting a `host_debug_log` declaration it found callerless. K7's
shared-mapping work then added `report_writeback_loss`, a genuine caller, and
the merge integration routed it through `runtime-core::debug_log` rather than
re-declaring the extern. So the import is now **live and linked** where before
it was declared and dropped. That is +1 on the campaign's primary metric in
exchange for making an unrecoverable writeback loss visible instead of silent.
**It is a real decision, not an accounting artifact** — see the open decisions
below.

Exports rose because K7's SysV mirror and K9's mount-root publication both added
entry points. **K13b is in flight to remove ~116 of them.**

Measure with `scripts/migration-ledger.sh --step <base> <tip>`. It is a
measurement, not a gate; line count is a poor metric but a useful hint.

## Trunk health, measured 2026-09-10

**`cargo test --workspace`: 3,671 passed, 0 failed.** Run on an otherwise
quiet-enough tree after merging nine agent branches and resolving two design
collisions. `cargo check` clean on **wasm32 and wasm64** as well as the host —
a native-only check called `no_std` code green twice this week, so both wasm
targets are part of the claim.

**Not claimed:** the full Vitest suite, which needs an otherwise-idle tree and
has not had one; and the browser, which runs as a consolidated pass at tier end
plus the maintainer's own check. Several agents discarded whole Vitest runs they
had contaminated with their own builds rather than report a number they could
not stand behind. That is the standard here, so the number above is the Rust
workspace and nothing more.

## The ledger moved the wrong way, deliberately — read this before quoting it

**In-scope TypeScript is −693, not −2,386.** It was −2,386 an hour ago. The
difference is K5 I6b's **+1,693**, merged knowingly.

**What that buys and what it costs.** I6b landed the KFLA archive writer and the
surviving TypeScript floor — the wire codec and the eight-act executor — both
*exercised*, not dormant: the writer reproduces the committed
TypeScript-written fixture byte for byte, and the executor drives a real
`wasm32posix-cc -shared` `.so` to a live instance and back out through
`dl_close`. But it does **not** delete `dylink.ts`, because six of thirteen
`DynamicLinker` methods have no host↔module contract yet (NDD-K5-1).

**So the tree now carries both implementations: `dylink.ts` at 6,340 lines and
the new planner TypeScript at 1,693.** That is precisely the parallel-
implementation state this campaign spent the day escaping, and it is here on
purpose rather than by drift.

**Why merge instead of holding it in the agent's worktree until I6c:** two
design collisions landed today (`local_build.rs`, `rootfs.rs`) in work that sat
out-of-tree for hours. Held work rots against a moving branch, and reconciling
it costs more than carrying it. The duplication has **one named owner and a
failing-test tripwire** — I6b pinned two of the six missing contracts as tests
that break when the contracts arrive — whereas drift has neither.

**When quoting the campaign's TypeScript figure, quote −693 and say what it
carries.** The −2,386 was true before this merge and will be true again, more
so, when I6c deletes 6,340.

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
| K10 | **DONE** | I1/I2/I3/I7 landed earlier; I4/I5/I6 landed 2026-09-10 — the Rust module runs and `wasi-shim.ts` is deleted. See §2x of the value plan |
| K10 | **COMPLETE** | I6 deleted `wasi-shim.ts` (−1,055); fixtures gate disproved; I4/I5 done |
| K14 | **DONE** | |
| K5 | **I6a DONE 2026-09-10; I6b owed** | Module built, projected, served on both hosts via the one side-module table; I6b = rewire + delete 6,340 lines |
| K8 | **incr 1 done; incr 2 REBASING** | Boot flip done in agent worktree; collided with K9 in `rootfs.rs` |
| K3 | **0a/0b/1/2 done; epoll cutover owed** | `wait_queue.rs` + `wait_shadow.rs` dormant |
| K7 | **piece 1 (SysV) CUT OVER; pieces 2/3 open** | SysV TypeScript deleted, TS −332. See "K7 cutover" below |
| K7 | **Rust landed; cutover MIS-SCOPED (confirmed twice)** | SysV re-cut RUNNING; see "K7 cutover" below |
| K12 | **DONE (scope corrected)** | GC elimination disproved; `fm_*` 72 → 70 |
| K11 | **PARTIAL** | 1 of 4 landed; 2/3/4 need a second pass (now unblocked) |
| K9 | **RUNNING** | Handle-only host contract, 83 → ~67 |
| K4 | **K4a: 21 more pairs shared; K4b probe PASS** | 16 pairs left, all one fork/exec/init family — NDD-K4-2 |
| K6 | **RUNNING** | Marshalling: SysV IPC, mqueue, sendmsg/recvmsg, ifconf |
| K13b | **NOT STARTED** | Export cull |
| K9 | **COMPLETE** | Imports 83 → **75**; 18 path-taking removed, 10 `*at` added |
| K4 | **RUNNING** | Worker entry unification |
| K6 | **DONE — cut over, TS net −1,880** | All four families; see below |
| K13b | **NOT STARTED** | |
| K6 follow-ons | **DONE — cut over, TS −212 / Rust −180** | Scatter/gather in the kernel; the msghdr/iovec wires retired. See below |
| K6 follow-ons | **DONE — cut over, TS −258 / Rust −240** | Scatter/gather in the kernel; the msghdr/iovec wires retired. See below |
| K13b | **DONE** | 121 dispatch-only exports withdrawn; artifact 320 → 199. See below |

## K6 — marshalling into Rust (2026-09-10)

**All four families are cut over, and the TypeScript is deleted.** The item's
ledger step is **TS −1,880 / Rust +1,813**, the first strongly net-negative
step in the campaign.

The mechanism is one new descriptor form,
`SyscallArgSize::KernelDereferenced`: the host copies nothing, passes the
caller's raw guest address, and stamps the caller's pointer width into the
private sixth channel slot. The kernel reads and writes the caller's structure
itself through `host_proc_read_bytes` / `host_proc_write_bytes` — the route
`SIOCGIFCONF` already took. **No new host import.**

| family | state |
|---|---|
| SysV `msgsnd`/`msgrcv`/`msgctl`/`shmctl`/`semctl` | cut over; 4 sizing exports deleted |
| POSIX `mq_timedsend`/`mq_timedreceive` | cut over; 1 sizing export deleted |
| `sendmsg`/`recvmsg` | cut over; both exports changed signature |
| `ifconf` | **was already done by K2**; verified, no TS remained |

### Three POSIX defects found and fixed on the way

1. **`semctl(SETALL)` could fail EACCES on a call POSIX permits.** The
   guest-side record encoder sized the `unsigned short` array with a
   preliminary `semctl(IPC_STAT)`, because `nsems` appears nowhere in the
   syscall arguments. IPC_STAT requires READ permission; SETALL requires only
   WRITE. This was the recorded "semctl GETALL/SETALL" pre-flip gap — closed
   from the other direction, by letting the kernel size the array from its own
   state.
2. **A blocked `msgsnd` would have become copy-at-success.** Linux's
   `do_msgsnd` calls `load_msg()` before the wait loop. The host had preserved
   that with a retry snapshot; reading caller memory at each dispatch would
   silently change it. The message is now retained in
   `BlockingRetryTarget::SysvMessage::pending_send`.
3. **`SCM_RIGHTS` receive capacity used one header size for both widths.** It
   is now derived from the CALLER's `cmsghdr`: 32 control bytes hold five
   descriptors for a wasm32 receiver and four for a wasm64 one.

`sendmsg`/`recvmsg` also gain native multi-buffer scatter/gather — the fixed
kernel wire held at most one iovec, so the host had to flatten — and their
transfers are now bounded by `SSIZE_MAX` rather than by a staging capacity.

### ABI — reported, not silenced

Two changes move `abi/snapshot.json` without an `ABI_VERSION` bump, which the
epoch decision permits, but neither is additive and both are recorded in
`docs/abi-versioning.md`:

- **five kernel exports removed** (`kernel_semid_ds_bytes`,
  `kernel_msqid_ds_bytes`, `kernel_shmid_ds_bytes`,
  `kernel_semctl_array_bytes`, `kernel_mq_descriptor_msgsize`);
- **`kernel_sendmsg`/`kernel_recvmsg` change signature**, from
  `(i32,i32,i32,i64)` to `(i32,i64,i32,i32,i64)`. An ABI 43 guest calling the
  four-argument form would trap.

### Gap this item did NOT close

**POSIX mqueue has no end-to-end test anywhere in the repo.** `mqueue.rs` has
Rust unit tests and the EMSGSIZE ordering is pinned by a source-shape contract
test, but no guest program exercises `mq_send`/`mq_receive` under the kernel.
The three Vitest cases that touched mqueue only ever exercised the host
preflight this item deleted. Worth an `examples/` program.
| K4 | **K4a COMPLETE (21 of 38 pairs); NDD-K4-2 open** | 16 pairs left as one inseparable fork/exec/clone/init family; K4b probe PASS |
| K6 | **COMPLETE** | All four families cut over; TS −1,978; no new host import |
| K13b | **COMPLETE** | 121 withdrawn, measured on the artifact: 320 → 199. See below |
| K13b | **RUNNING** | ~116 of ~320 exports removable; ABI-stability win, not host-surface |
| `pathconf`/`trap-signals` | **COMPLETE** | Census row disproved 3 ways; `_PC_PIPE_BUF` fixed on POSIX (both copies wrong); host-native gained trap→signal mapping |
| `constants.ts` | **SPLIT; NDD dissolved** | `crates/wasm-artifact` (2,258 lines); exec path cut over; needs a module, not an export |
| iovec / msghdr wire | **RUNNING** | `writev`/`readv`/`preadv`/`pwritev` + retiring the dead msghdr wire |

### K6 validation — what was run, and what it proves

Against a kernel rebuilt from this branch and installed into
`local-binaries/kernel.wasm` (the ambient path guest tests resolve):

| evidence | result |
|---|---|
| `cargo test -p runtime-core -p kandelo -p wasm-posix-shared` | green (1,887 + 4 + 3 + 64) |
| `cargo check -p runtime-core -p kandelo` for **wasm32** | clean — the shipping target, and `no_std` |
| `host/test/sysv-ipc.test.ts` | 2/2, **wasm32 + wasm64** |
| `host/test/mqueue.test.ts` (new) | 2/2, **wasm32 + wasm64** |
| `host/test/scm-rights-semantics.test.ts` | 16/16, **wasm32 + wasm64** |
| `host/test/scm-rights-pipe-lifetime.test.ts` | 2/2, **wasm32 + wasm64** |
| `scripts/xtask.sh verify-fresh` | exit 0 |
| `scripts/check-abi-version.sh` | snapshot in sync, version consistent |
| `tsc --noEmit -p host` | 32 errors, all pre-existing (identical count at `44f321ae4`) |
| `host/test/sigpending.test.ts`, `chown-sentinel.test.ts` | 3/3 once `rootfs.vfs` existed |
| `host/test/kernel.test.ts` | 6/6 — after fixing a real regression, below |
| `host/test/ifhwaddr.test.ts` | 2/2 run alone, **wasm32 + wasm64** — the `ifconf` proof |

### The regression the targeted suites caught

`probeMqueueNotificationCapacityForTest` fires a real `mq_timedsend` to
make a notification pending. It staged the message byte in kernel scratch
and passed a **scratch** offset in arg 1 — correct while the host
marshalled the message, and wrong the moment that argument became
`KernelDereferenced`, after which the kernel read the CALLER's memory at
that offset.

It is worth naming because of how it hid. The probe hand-builds its
channel instead of going through the marshaller, so nothing in the
descriptor change reached it and no grep for the syscall name would have
found it — only running the test did. All 17 hand-built `CH_SYSCALL`
dispatch sites in `kernel-worker.ts` were then audited: this was the only
one naming a K6 syscall, and the generic paths replay saved
`adjustedArgs`, which carry the guest address unchanged.

### On the full `vitest run host/test` numbers — do not use them

Three full runs were attempted and none is usable as evidence about this
change. Two were destroyed by the concurrency trap above. The third was
otherwise-idle for this worktree but ran on a machine with six agents:
**64 of its 145 test failures are bare timeouts**, 33 more are missing
browser aliases, and the failing SET changed between runs — suites that
pass in isolation appeared and disappeared. A changing failure set across
identical runs measures the machine, not the tree.

Every file in K6's blast radius was therefore accounted for individually,
by re-running it alone or by reproducing its failure on the base commit:

| suite | verdict |
|---|---|
| `kernel.test.ts` | real regression, mine — fixed, 6/6 |
| `ifhwaddr` | passes alone, both widths (17–19 s/case; 30 s timeout is marginal under load) |
| `kernel-export-failure-audit` | **fails at `44f321ae4` too** — reproduced on base source |
| `kernel-reservation-export-contract` | pre-existing, reproduced on base |
| `kernel-scratch-transfer-boundaries` | only the known pre-existing epoll case |
| `wasi-shim` | `ENOENT` on a missing `host/test/fixtures/wasi-hello.wasm` |
| `abi-version` | 5 s timeout under load |

The 22 end-to-end cases are real compiled C programs running under the
kernel, not host-side mocks — which matters here, because the mocks are
precisely what this item deleted. They exercise `msgctl` IPC_SET/IPC_STAT,
`semctl` IPC_STAT/GETALL/SETALL/GETVAL including post-`IPC_RMID` EINVAL,
`shmctl`, `msgsnd`/`msgrcv`, `mq_send`/`mq_receive` with both EMSGSIZE
directions, and `sendmsg`/`recvmsg` fd passing across stream, peek,
datagram and truncation paths.

**Not proven:** browser. The consolidated per-tier browser pass owns it. No
benchmarks were run and no performance claim is made.

**wasm64 note.** `runtime-core` and the kernel ship to **wasm32 only** —
`wasm64-unknown-unknown` is not an installed Rust target and nothing builds
the kernel for it. wasm64 is a *caller* data model, which is why every
end-to-end suite above runs both widths against the one wasm32 kernel.

### Two build-environment findings

1. **`KANDELO_SOURCE_CACHE_ROOT` did nothing through `./run.sh`.** It was
   missing from `scripts/dev-shell.sh`'s `--keep` allowlist, and
   `nix develop --ignore-environment` stripped it before xtask could read
   it — so every `./run.sh rebuild` silently used the shared `$HOME` cache
   that the flag exists to avoid. Fixed and verified both ways. An
   isolation flag that quietly does nothing is worse than no flag: it makes
   the hazard unfalsifiable.
2. **A full `vitest run host/test` shares mutable state with any build
   command, and loses to it.** Two runs were destroyed this way before the
   pattern was obvious:

   - overlapping `./run.sh rebuild kernel`, whose `[>>] Cleaned kernel` step
     removes the ambient `local-binaries/kernel.wasm` — 74 files failed with
     "package resolver did not materialize";
   - overlapping `scripts/check-abi-version.sh`, which **rebuilds the kernel
     wasm on every invocation** (§2d already said so, and the trap was
     re-triggered anyway) and republishes the program index — 60 files failed
     with "program package index target changed before publication: local
     mirror identity or contents changed:
     `packages/registry/program-packages.json`".

   The tell in both cases is that suites which pass in isolation appear in the
   failing set, and the errors name provisioning rather than behaviour. **The
   full suite needs an otherwise-idle tree.** Do the builds first, then run it
   and touch nothing.
3. **Provision with `./run.sh setup`, not piecemeal.** `sigpending` and
   `chown-sentinel` sat for ~50s each and then failed on a missing
   `rootfs.vfs`. `docs/agent-guidance/validation.md` step 2 already says
   `./run.sh setup` produces `host/wasm/rootfs.vfs`; the gap was mine — I had
   run `build-musl.sh` and `build-programs.sh` individually and never the
   front door. The lesson is not a missing doc, it is that a partial
   provisioning leaves failures that read like defects: a missing image
   surfaces as a ~50s timeout, and the resolver error naming five checked
   paths is the only thing that distinguishes it.

## Host import surface

**84**, measured on a freshly built kernel (`wasm-objdump -x
local-binaries/kernel.wasm | grep -o "env\.host_[a-z_0-9]*" | sort -u | wc -l`).
84 → 85 (K8's `host_image_read`) → 83 (K3 0b removed two dead ones) → **84**
(K7's SysV cutover made `host_debug_log` reachable).

**That last step declared nothing and added no capability.**
`host_debug_log` is the contract's existing single diagnostics sink; it was
missing from the artifact only because the code reaching it was dormant, and
cutting over made it live. The §4 concept table is unchanged. Verified by
diffing the import lists of a base-commit kernel and a cutover kernel: the
difference is exactly `env.host_debug_log`.

**Generalizes to every remaining dormant module:** a cutover's import delta is
not visible in the diff. Measure it on a built kernel, before and after.

**One new import is sanctioned**, gated on measurement: cross-memory
`host_proc_compare_bytes`, the third member of the read/write family. See §2w of
the value plan for why it protects the abstraction.

**The measurement gate is now satisfied.** K7's SysV cutover measured a 3.7×
regression on a syscall boundary holding a live-peer shared attachment, caused
by exactly the full-range copy the compare member exists to avoid (§2x of the
value plan). Still unspent and still the maintainer's call — but no longer
waiting on evidence. Note the cheaper remedy first: `host_proc_read_bytes`
currently copies its range **twice** (`host/src/kernel.ts` allocates via
`sliceUint8Array` and then copies again into the kernel destination), which
needs no import at all.

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
| K5 I6b (I6a done; module built, projected, served) | `dylink.ts` + `dylink-fork-archive.ts` | 6,340 |
| ~~K10 I6~~ | ~~`wasi-shim.ts`~~ | **PAID 2026-09-10** |
| K8 i2 | `vfs/rootfs-manifest.ts` | 354 |
| ~~K7 re-cut (1)~~ | ~~SysV half of `kernel-worker.ts`~~ | **PAID: 638 removed** |
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
1. ~~**SysV half, now**~~ — **DONE 2026-09-10.** The half was separable exactly
   as scoped: both containers and everything reading them are deleted, and the
   boundary early-out was preserved by caching the attachment-population count
   and refreshing it from the kernel at every mutation site rather than calling
   per boundary. It also came out narrower than the code it replaced, and it
   surfaced a real POSIX coherence defect. See §2x of the value plan.
2. **Write the coherence layer in Rust**, sized as policy rather than as
   plumbing.
3. **Anon + file cutover**, gated on that targeted benchmark.
   `benchmarks/programs/sysv-shm-bench.c` now exists as the shape such a
   benchmark needs: a live peer, a real attachment, a loop of boundaries, and
   clean/dirty cases reported separately because they move in opposite
   directions.

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

### I6a — DONE (2026-09-10). I6b is now a rewire

`crates/dylink-module` is a standalone wasm module with **zero imports**
(verified by `wasm-objdump` on every build; the check was itself falsified
against a control module that does import). 21 `dl_*` exports drive the
planner, and `crates/dylink/src/wire.rs` gained the six session codecs the
per-act pair was missing, so a load can now be STARTED, not just stepped.

**One table, three modules.** K10 and I generalized the same machinery in
parallel and the merge produced 30 conflicting hunks. `CORESIDENT_SIDE_MODULES`
is the survivor: its `(file name, target arch, required)` artifact list is
strictly better than my prefix+width derivation, which could only describe
artifacts named `<prefix><width>.wasm`. Mine is dropped; the planner is a third
row. Note the table is **no longer all co-resident** — fork-module and
wasi-module are PIC side modules in guest memory, the planner imports nothing
and owns its own. Membership says how a module is delivered, not how it is
built.

**A latent break in the incumbent, found and fixed.** The engine already
projected `wasi-module`, but `binary-resolver.ts` still admitted only the two
fork-module artifacts. An unadmitted node does not degrade one module: the
projection parse throws before ANY binary resolves. Demonstrated on the
incumbent resolver against a real manifest — `node "wasi-module" (wasm32) is
neither an exact v2 program node nor a root-mirror package` — which would have
taken down every SourceOnly boot. The allowlist now names all three and says it
must track the table.

**Evidence.** `verify-fresh` EXIT=0 on the merged table; EXIT=1 naming
`dylink-module`, and separately `wasi-module`, when one byte of that staged
member is changed; EXIT=0 after restore. `dylink_module32.wasm` resolves
through the real `binary-resolver.ts` under `source-only-v1`. Real-`dlopen`
suite with the kernel present: **118 tests, 115 passed / 2 failed / 1 skipped**
— the 18 that silently skip now EXECUTE; the 2 failures are the tracked pthread
`__wpk_fork_frame_reserve` gap, the 1 skip is wasm64. `cargo test` dylink 91,
dylink-module 10, fork-codec 444; `cargo check` green on host, wasm32, wasm64.

**Ledger: in-scope TS +140.** I6a is pipeline and delivery; it deletes nothing.
The 6,340 lines are I6b's.

**Unproven: three of the four browser registrations.** The Vite alias, the
`?url` artifact module, and the fetch/transfer/compile chain fail only in a
SourceOnly browser build and need a boot. Browser products were BLOCKED here by
unrelated package failures (`node`, `vim`, `wget`, `ruby-browser-bundle`,
`coreutils-docs`). The fourth — resolver admission — is proven above.

**Eighth silent-success defect, fixed:** `crates/fork-module/build-wasm.sh
--verify-fresh` exited 0 when the artifact did not exist at all.
`ensure_coresident_side_modules_built` builds only when that check FAILS, so on
a fresh worktree the module was never built and the local-build died much later
at projection finalization telling you to run the script by hand. Absence is
not freshness. wasm32 is now required; wasm64 stays best-effort.

Note: adding a workspace member changes `Cargo.toml` and `Cargo.lock`, which
are declared `packages/registry/kernel/build.toml` inputs, so the kernel's
cache key legitimately moves and the kernel rebuilds once. Closure-derived keys
working, not a regression.

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

## K4a continuation — 21 pairs shared, and pure subtraction is nearly spent

**Re-measured census at base `49c0718ee`** (top-level `function`, `const`
function and `interface`/`type` declarations shared by name between the two
entries): **38 common — 3 byte-identical, 0 cosmetic, 35 differing**, holding
3,379 browser and 2,917 node lines. That is the same population the previous
entry describes as "13 identical / 3 cosmetic / 39 differing"; the counting
differs (renamed near-twins, `const` arrow functions), the conclusion does not.

**After this pass: 17 common — 1 identical, 16 differing**, holding 2,808
browser and 2,370 node lines. **21 pairs unified.** The entries went 4,681 →
3,965 (browser) and 4,072 → 3,461 (node); `process-lifecycle.ts` went 464 →
1,711.

**Ledger `49c0718ee..51f23b85d`: in-scope TS -80** (1,400 added / 1,480
removed), Rust unchanged.

### Six protocol drifts closed, each toward the correct half

Ordered by how observable the difference was:

| drift | what differed | resolution |
|---|---|---|
| pre-init pipe requests | Node returned `uninitializedKernelPipeResult`; the browser let the kernel throw into a protocol error | Node's guard, universally — a caller learns the pipe is absent, not that the protocol broke |
| kernel throws in pipe/inject | only the browser had a `respondError` guard | browser's guard, universally |
| exec of a directory | Node refused; the browser returned the bytes | Node's check, universally |
| `read_vfs_file` `includeMode` / byte transfer | one feature per host | both, on both |
| rootfs-export quiescence | only the browser counted in-flight worker teardowns | both hosts track them now, so the predicate is the same |
| duplicate process exit | Node re-reported; the browser dropped it silently | Node's re-report, made idempotent by `reportedExits` |

Also: the browser had lost the `.catch()` Node had on `worker.terminate()`
inside fatal kernel teardown, so a refused termination became an unhandled
rejection on top of the failure being reported. Node gained the browser's
per-process `maxPages` (drift D7) and its structured allocation-failure
diagnostic; Node's rootfs and reap diagnostics keep their stacks. The browser's
sequential exit fences are now concurrent, as Node's already were.

### The terminate-fence boundary explained every "bug-shaped" difference met

Every remaining asymmetry in the shared code traced to `await
worker.terminate()` being an ownership fence on Node and not in the browser,
exactly as the previous entry records — and each is now *declared* on
`ProcessLifecycleHost` rather than inferred:

- `exitRetirementFences` — the browser's `memoryRetirementSafe` flag and its
  main-thread framebuffer-alias release. Node returns `true`, because
  termination already proves what they protect.
- `processExitSettleMs` / `threadWorkerSettleMs` — compatibility delays
  after a termination that reports nothing. Node returns 0.
- `stopKernelRealm`, `rootfsBaseImage`, `execMountIO`, `resolveExecFile`,
  `defaultMaxPages`, `defaultThreadSlots`, `processMemoryAllocator`,
  `reportProcessExit`, `isInitReady`, `externrefProcessOwner`.

**One boundary was deliberately declared rather than unified.**
`defaultExitCrashSignum`: the synthesized signal-style reap that keeps a
parent's `waitpid` from blocking when a worker dies without SYS_EXIT_GROUP is a
*callee* responsibility in the browser (it synthesizes on every exit and relies
on the kernel's `hostReaped` guard) and a *caller* responsibility on Node
(`finalizeProcessWorker` and the vfork containment path call
`notifyHostProcessCrashed` themselves). Same kernel call, two call graphs.
Collapsing it changes Node's worker-'exit' path in a way the Node suites cannot
prove, so behaviour on both hosts is bit-for-bit unchanged and the difference is
visible in one place.

### Genuine defect found, outside the refactor

**`scripts/dev-shell.sh` silently discarded `KANDELO_SOURCE_CACHE_ROOT`.** The
dev shell enters `nix develop --ignore-environment` with an explicit `--keep`
list, and the variable was not on it — nor were
`WASM_POSIX_LOCAL_INSTALL_SOURCE` and `WASM_POSIX_LOCAL_INSTALL_SESSION`. Since
the dev shell *is* the verification contract, every agent told to isolate its
cache was isolating nothing, and the campaign's own recorded kernel-install
recipe installed nothing. Verified before and after with `dev-shell.sh bash -c
'echo $KANDELO_SOURCE_CACHE_ROOT'`. Fixed in `5ca6029c5`. **This is the actual
mechanism behind the "three consecutive `prepare-browser` failures" and the
suites reported as flaky.**

### Validation actually run

- **7 host-parity/contract suites: 48 passed / 1 failed of 49 executed** —
  byte-identical to the same suites at `49c0718ee` run in a separate worktree.
  The failure is the coordinator's `kernel-scratch-contract`
  unreviewed-memory-authority case, with the same 20 findings before and after.
- **23 worker-lifecycle/entry suites: 236 passed of 236 executed, 23/23
  files.** This number only exists because the worktree was fully
  provisioned; the same command in a partly-provisioned tree reported
  209/213 with 3 failures and 1 skip, and earlier still 5 failing files.
  The executed count is the result — "green" was available at every stage.
- `tsc -p host/tsconfig.json`: clean for all three changed sources; the host
  project's 32 remaining errors are unchanged and pre-existing (bundler-only
  imports, `rootDir` scope, vendored openssl TLS).
- **The two suites that cover this pass's riskiest change were contributing
  zero tests until the last provisioning step.** `vfork-lifecycle-guest`
  (6/6) and `spawn-pid-authority` (17/17) both failed at *collection* on a
  missing fixture `.wasm`, in this worktree and at `49c0718ee` alike. Among
  the six now-executing vfork tests are "contains a compute-running borrower
  after an external fatal signal", which drives the shared
  `containVforkAddressSpace`, and "releases the parent after exact trap and
  signal teardown", which drives the shared `finishProcessExit`. Those were
  the two changes reasoned about but not executed.
- **Browser: NOT run.** Everything above is Node. The browser-visible changes
  are the pre-init pipe guard, the exec-of-a-directory refusal, the
  `read_vfs_file` byte transfer, the concurrent exit fences, and the fatal
  teardown `.catch()`.

### Fresh-worktree provisioning: what `./run.sh setup` does not do

Every step below turned erroring or non-collecting files into executing
ones, and none is optional for a worktree that needs to run guest suites:

1. `git submodule update --init libc/musl`, then `scripts/build-musl.sh` and
   `scripts/build-musl.sh --arch wasm64posix`. Note `--arch wasm64` is
   rejected; the name is `wasm64posix`.
2. `npm --prefix host install` — `vitest` is a `host/` devDependency.
3. **`npm install` at the repo root.** `./run.sh setup` does not do this, and
   without it `rootfs` fails with `build-rootfs: sealed build requires locked
   root dependency node_modules/tsx/dist/cli.mjs` and `node-browser-bundle`
   with `locked tsx CLI not found`. Neither message says "run npm install".
   `rootfs` then cascade-blocks `platform-rootfs`, `browser-main-shell`,
   `browser-nginx`, `browser-wordpress`, `browser-node`, `browser-lamp`,
   `shell`, `node-vfs`, `nginx-vfs` and `coreutils-docs` — so an agent told
   not to fight browser provisioning reads this as the browser being broken.
4. `crates/fork-module/build-wasm.sh`.
5. A kernel build installed to `local-binaries/kernel.wasm` via
   `install-local-artifact` — `./run.sh rebuild kernel` alone does not
   repoint it.
6. `./run.sh rebuild rootfs` (writes `host/wasm/rootfs.vfs`).
7. `scripts/build-programs.sh` — the test-fixture `.wasm` files.

A full `./run.sh setup` in this worktree still exited **1** with `php`
(ICU `pkg-config`) and `mariadb-test` failing for their own reasons. Those
two are unrelated to the host runtime and are not this item's.

### Six structural parity assertions updated — each still checks its subject

Two were literal-argument or delimiter breakage
(`node-process-teardown-ordering`, `process-generation-detach-host-parity`'s
`terminateThreadWorkers(pid)`). Three now assert against
`process-lifecycle.ts`, which is **stronger**: with one implementation, the
invariant cannot hold on one host's path and be missing from the other's —
`fork-externref-host-parity`'s externref-generation release,
`process-generation-detach-host-parity`'s ledger route, and
`host-owned-process-reap`'s terminate → detach → reap ordering (all three
also still require both entries to bind the shared function).
`host-diagnostic-
routing`'s poisoned-kernel test gained an assertion it never had — that the
teardown reaches `host.stopKernelRealm()`. `spawn-host-parity` gained
`expectEntryProvides`, which accepts a declaration *or* a binding from
`./process-lifecycle`: sharing a function must not read as deleting it.

### What is left, and why it is one item rather than sixteen

**16 differing pairs, 2,808 browser / 2,370 node lines.** Twelve of those lines
are `post` (3/3), the irreducible host floor. `forkModuleInitFields` (11/16) is
a real host difference. The rest is one connected subsystem:

| pair | browser | node |
|---|---|---|
| `handleInit` | 472 | 265 |
| `handleExec` | 494 | 455 |
| `handleVfork` | 397 | 396 |
| `handleOrdinaryFork` | 295 | 284 |
| `handleClone` | 283 | 266 |
| `handleSpawn` | 211 | 200 |
| `handlePosixSpawn` | 204 | 186 |
| `installProcessWorkerListeners` | 168 | 98 |
| `performDestroy` | 143 | 133 |
| `ProcessInfo` | 37 | 27 |
| `handleFork` (identical), `handleExit`, `handleDestroy`, `reportProcessExit` | 80 | 68 |

They cannot be taken one at a time. Every one of them constructs or tears down
a process generation, so they all need the same three new host hooks — a
`ProcessInfo` factory (`allocateProcessGeneration`, `memoryRetirementSafe`,
`framebufferExposed`, `argv` exist only in the browser's record), a worker
constructor, and a rollback-fence hook — plus an adjudication of D15
(`waitForProcessTeardowns`, a browser-only pre-fork barrier with no stated
correctness argument). Sharing three of them buys the hooks once and the other
seven nearly free; sharing one buys the hooks and saves almost nothing.

`handleOrdinaryFork` is the measured example: 295/284 lines with only 71
changed, so roughly 75% is already identical.

**NEEDS-DEFER-DECISION (NDD-K4-2): the fork/exec/init family, as one item.**
- *What:* the 12 pairs above, ~2,700 node lines, behind ~5 new declared host
  hooks.
- *Why now:* it is the largest single TypeScript reduction left in the campaign
  and the last one in K4; the shared module's fixed cost is fully paid.
- *Cost now:* it is the campaign's most delicate code — fork, vfork, clone,
  exec and the init prologue — and the browser half cannot be executed from
  Node. Expect roughly a session's careful work plus a browser pass.
- *Cost later:* the drift continues. This item's own census moved measurably in
  a day, and 70%+ of pairs differing is what produced D1–D17 in the first
  place.
- *Recommendation:* take it, as **one** item, with the fork-path guest suites
  provisioned first (`rootfs.vfs` + `local-binaries/kernel.wasm`) so
  `vfork-lifecycle-guest`, `wait-lifecycle-guest` and `fifo-lifecycle-guest`
  actually execute rather than erroring on a missing artifact — that is the
  gate this item needs and the earlier tranches did not have.

**`parseShebang` is shared, and NDD-K4-1 is untouched.** Both copies were
byte-identical, so folding them in was pure reuse: no new export, no ABI
surface, no state. The kernel-owning question — `kernel_exec_target_shebang`
needing a prepared target token the side-effect-free spawn preflight has none
of — is unchanged, and now has one call site to repoint instead of two.

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

## K13b analysis — done, and the item is now mechanical (2026-09-10)

Measured on the branch, no builds contended.

**The kernel exports 309 `kernel_*` symbols**, matching 309
`pub extern "C" fn kernel_` declarations in `crates/kernel/src/wasm_api.rs`.

**118 of them have zero references in `host/src` and `host/test`.** That does
**not** mean dead — it means **dispatch-only**, and the distinction is one this
campaign already got wrong once: `kernel_brk` and `kernel_time` were called
"dead" on exactly this evidence and were live, reached from inside
`wasm_api.rs` by the dispatch path rather than from the host.

**They are removable because dispatch does not use the export.**
`dispatch_channel_syscall` calls them as **plain Rust function calls** —
`wasm_api.rs:4267` is `kernel_close(a1)`, not a re-entry through the wasm
export table. So `#[unsafe(no_mangle)] pub extern "C"` is vestigial for these:
drop the export attribute, keep the body and whatever Rust visibility the
callers need, and the symbol leaves the wasm while dispatch keeps working.

**Consumers that must keep their export — the check that matters.** Only **2**
of the 118 are named by `crates/host-native`:
`kernel_exec_target_resolve_shebang` and `kernel_wait4`. Everything else is
referenced only from Rust that links against the crate:
- `crates/kernel/src/lib.rs` (internal) — plain `fn` suffices
- `crates/kernel/tests/wasm_api_channel_pointer_contract.rs` — integration
  tests see only the public API, so `pub fn`, but no `extern "C"`
- `crates/runtime-core/src/syscalls.rs` — cross-crate, so `pub fn`

**Result: 116 of 309 exports can go. Surface 309 → ~193.**

**What this is worth, stated honestly.** Kernel exports are **free under V4** —
that goal counts host *imports*, and this changes none. The value is **V3**:
`docs/agent-guidance/abi.md` lists kernel Wasm exports as part of the ABI
contract, so a smaller export surface is a smaller contract for a VFS image to
depend on, and fewer things that can break image compatibility across an epoch.
Secondarily V2/maintainability: 116 fewer `extern "C"` boundaries where a
signature can drift from its Rust caller.

**It is ABI-adjacent and stays under ABI 44.** `abi/snapshot.json` regenerates;
no `ABI_VERSION` bump, per the maintainer's ruling that the whole campaign is
one epoch.

**Held, not blocked.** Seven agents already contend on the shared build cache
and one lost four provisioning attempts to it; an eighth costs more than it
gains. Dispatch when a slot frees — the analysis above is the item.

### K13b done — 121 exports withdrawn; the analysis had the shape right

Base `aab5314c0`, worktree `.claude/worktrees/agent-a74c8d3aa3a9a9910`.
Ledger: **in-scope TS +0, Rust production −121** (test +21, the locator fix
below). No `ABI_VERSION` bump; no new `env.host_*` import.

**Measured on the built artifact, not the source.** `kernel_*` exports in
`kandelo_kernel.wasm`: **320 → 199**. Snapshot `kernel_exports` entries:
322 → 201. The snapshot regeneration diff is **0 lines added, 605 removed**,
of which exactly 121 are `"name": "kernel_..."` — so the change is
export-surface-only, with no signature, constant, or struct layout moving, and
the generated libc headers plus `host/src/generated/abi.ts` regenerated
byte-identically.

**Re-measured, as instructed, and the figures had moved.** Three items merged
after the analysis was written: 320 declared exports rather than 309, and
**122** with zero references in `host/src`/`host/test` rather than 118.

**Two corrections to the analysis, both in the same direction.**

1. **`kernel_wait4` was not a keeper — 121 removable, not 120.** The analysis
   named two functions that `crates/host-native` references and kept both.
   Only one is a consumer. `kernel_exec_target_resolve_shebang` is read with
   `kernel.get_typed_func(...)`: host-native runs the kernel under wasmtime, so
   that is a genuine export-table read, and it keeps its export.
   `kernel_wait4` appears only in
   `linker.func_wrap("kernel", "kernel_wait4", ...)` — host-native SUPPLYING
   that import to a GUEST. Its own comment says it is registered defensively
   for a guest that happens to import the name, and that the current
   `channel_syscall.c` glue does not. Supplying an import and consuming an
   export share a name and nothing else.
2. **The scariest-looking consumer is a dead file.** 107 of the 122 appear in
   `libc/glue/syscall_imports.h` as `__attribute__((import_module("kernel")))`
   declarations — which reads as a live guest/kernel contract and would
   make this item impossible. It is not: those declarations belong to
   `syscall_glue.c`, which `channel_syscall.c` replaced (that file's own header
   says so) and which **no build script compiles** —
   `sdk/test/cc.test.ts` even asserts the SDK never passes it. Guests cannot
   reach these exports by any route: a guest's `kernel.*` import namespace is
   `buildKernelImports` in `host/src/worker-main.ts`, a closed set of
   hand-written JavaScript, and `assertSupportedKernelFunctionImports` rejects
   any module importing a name outside it.

**Verified against every consumer of the export table**, not the hosts alone:
`host/src` and `host/test` (zero); `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` and
its OPTIONAL sibling in `crates/shared/src/lib.rs` (zero overlap);
`wasm_require_exports` in `packages/registry/kernel/build-kernel.sh` and
`KERNEL_REQUIRED_EXPORTS` in `run.sh` (zero overlap); and every
`get_typed_func`/`get_func`/`get_export` name literal in
`crates/host-native/src` — 40 exports are read, none of them removed.

**One test broke, and it was not asserting on the ABI surface.**
`wasm_api_channel_pointer_contract` slices five `kernel_*` bodies out of
`wasm_api.rs` with `include_str!` and asserts on guest-pointer safety inside
them. It located those bodies by the literal `pub extern "C" fn <name>`, so
five became unfindable and two of four tests failed with "export start". The
test crate never instantiates the kernel; the export attribute was only the
text delimiter. Fixed by teaching the locator both declaration forms — not by
restoring the exports — and verified the slices are still tight rather than
vacuously passing: each body runs from its own signature to its own closing
brace. The helper now also trims the next item's doc comments, and the two
hand-written `"\n/// recvmsg"`-style end markers the file's own comment warned
about are gone.

**What it is worth, unchanged from the analysis.** Kernel exports are free
under the smallest-host-surface goal, which counts host *imports*; those stay
at 76. The value is V3 ABI-contract size — 121 fewer symbols a VFS image can
bind to — and V2, 121 fewer `extern "C"` boundaries where a signature can
drift from the Rust caller that is actually reached.

## Mid-campaign census — six uncovered items, and a 13th disproved claim in our own ledger

Run read-only on 2026-09-10 while seven agents held the build cache. The
maintainer asked for this at campaign end; running it early means the answer is
ready rather than started cold.

### The finding that matters most is a false KEEP I wrote

**`host/src/constants.ts` (3,031 lines) is classified KEEP in
`2026-09-09-runtime-ts-disposition-ledger.md` on the premise that it is
"a re-export shim … only 7 own declarations". That is false.** Verified
directly: **one** `export {` line, **26 exported declarations**, ~55 private
ones, across 3,031 lines. It is a complete **WebAssembly binary reader** —
LEB128, type/subtype/composite decode, instruction-immediate skipping,
import/export/custom-section descriptors — plus the fork-artifact validators,
`extractHeapBase`, `extractAbiVersion`, `detectPtrWidth`, and
`describeWasmArtifactPolicyFailures`.

It fails the KEEP test's first part outright: **it touches no host object**; its
input is an `ArrayBuffer`. And the ledger contradicts itself — its own entries
for `worker-main.ts` ("custom-section parsing is deterministic computation over
bytes → MIGRATE") and `binary-resolver.ts` ("required/forbidden-export checks
belong with the ABI in Rust") say the opposite about the same kind of code.

**Thirteenth disproved claim in this campaign, seventh authored by the
coordinator.** Reclassify: **MIGRATE**.

### Ranked uncovered candidates

| # | Path | Lines | Goal served, concretely |
|---|---|---|---|
| 1 | `host/src/constants.ts` | 3,031 | **V2/V3** — the code deciding whether an artifact matches the ABI epoch, parsing bytes in the language with no types over them. **V1** — `worker-main.ts` and `binary-resolver.ts` already carry their own partial copies |
| 2 | `pathconf.ts` + `statfs.ts` | 115 + 23 | ~~V4~~ **DONE 2026-09-10, and this row was wrong** — see value plan §2y. Two of the four imports no longer exist (K9 took them; the census read a stale doc comment at `host/src/kernel.ts:16`), and the surviving two are **real host capabilities**: host-native answers `host_fstatfs` with `fstatvfs(2)` and `host_fpathconf` with `fpathconf(3)`. The genuine defect was the JavaScript hosts answering `host_fpathconf` from a *copy* of the kernel's table — deleted; and `_PC_PIPE_BUF`, which **both** copies got wrong |
| 3 | `trap-signals.ts` | 139 | **V1 — DONE 2026-09-10.** Confirmed exactly as stated. Policy now in `wasm_posix_shared::trap_signal`; host-native maps wasmtime's typed `Trap` structurally and posts a real process exit, the JavaScript hosts pass the engine message to `kernel_classify_wasm_trap_signal`. Two residual host-native limits logged in `docs/future-improvements.md` |
| 4 | `thread-allocator.ts` | 186 | **V2/V4** — pthread slot arena, growth direction, and the `pthread_create` EAGAIN quota: address-space allocation and a POSIX resource limit, in TS, over ABI constants Rust already owns |
| 5 | `vfs/device-fs.ts` | 339 | **V4** — ELIMINATE; see duplicated authority #2 below |
| 6 | `shell-runtime-layout.ts` | 60 | **None — it is toolchain**, mis-located. Its only callers are `images/vfs/scripts/*`, explicitly out of scope, but it sits in `host/src` so `migration-ledger.sh` counts it as in-scope runtime TS. **Moving it corrects the headline metric.** |

`file-offset.ts` (179) and `append-contract.ts` (33) judged **KEEP**: they
validate values returned *by a host callback* that could substitute a mutable
global or a `Symbol.hasInstance` hook — the same boundary hazard as §2.1's
capacity-carrying views. Their errno *choice* should still be stated by Rust.

### Dead — no production caller

- **`host/src/fork-reference-unsupported.ts` (26 lines).** Six hits total: three
  in the file, three in its own test. Exactly §3's "tests depend on it" case.
- **`constants.ts:2435 wasmHasCompleteForkInstrumentation`** — a **stranded
  second copy**; `worker-main.ts:3161` defines and uses its own
  `hasCompleteForkInstrumentation`. Callers of the `constants.ts` one are 12
  test references.
- `readWasmExportNames`, `wasmIsRelocatableObject`,
  `readWasmCustomSectionNames`, `wasmContainsLegacyAsyncify`,
  `wasmImportsKernelFork` — not dead, but not API either: used only internally
  and by tests, and should not be exported.

### Duplicated authority — three more, bringing the campaign total to SEVEN

1. **The `pathconf` limit table — RESOLVED 2026-09-10.** `pathconf.ts:54
   filesystemPathconf` vs `syscalls.rs:16925 filesystem_pathconf_value`, same
   ~20 names, disagreeing on `_PC_PIPE_BUF`. The host copy is gone. **Note for
   the pattern:** the previous six duplicated authorities were all resolved by
   deleting the host copy, and doing only that here would have shipped a POSIX
   bug — POSIX makes `_PC_PIPE_BUF` mandatory for a FIFO and a directory and
   gives `{PIPE_BUF}` a `<limits.h>` minimum, so TypeScript's -1 and Rust's
   EINVAL were **both** non-conforming. The surviving answer is neither side's.
2. **The `/dev` node table.** `vfs/device-fs.ts` vs `syscalls.rs:218
   match_virtual_device` + `devfs.rs`. Rust has `/dev/full` and TS does not; TS
   maps `/dev/console` to a device that throws `ENXIO` while Rust aliases it to
   `Null` with a comment explaining why probes must succeed. **The TS copy is
   unreachable** — `is_host_backed_devfs_path` is `/dev/shm` only — yet it *is*
   mounted on both hosts, so it reads as a live floor.
3. **Fork-artifact contract validation.** `constants.ts`'s
   `describeWasmForkArtifactContractFailures` and the descriptor validators vs
   `crates/fork-instrument/src/contract_inventory.rs` (754 lines, wasmparser)
   and `fork-codec/src/{imported_globals,imported_tables}.rs` (592 + 599). Two
   decoders of one format, one hand-rolled — and the TS side runs on **every
   exec**.

## K6's two follow-ons — scatter/gather cut over, the wires retired (2026-09-10)

Worktree `.claude/worktrees/agent-afc1b42a208645bd5`, base `020d1dbfa`.
**Ledger `020d1dbfa..05ff2a59e`: in-scope TS −212, Rust −180**, over 17
commits. Net-negative in both, because the work removed more than it added on
each side: the TypeScript iovec marshaller, and — on the Rust side — a whole
parallel implementation plus the fixed wire format nothing produced any more.
No `ABI_VERSION` bump. **Host imports measured on the built artifact:
`WebAssembly.Module.imports` reports 77 imports, 76 of them `env.host_*` —
unchanged, and no `fn host_*` extern declaration is added or removed by the
diff.**

### 1. `writev`/`readv`/`preadv`/`pwritev`/`preadv2`/`pwritev2` — cut over

All six, not the four the item named: they share one TypeScript code path, so
leaving two behind would have deleted nothing. They use K6's
`SyscallArgSize::KernelDereferenced` — the host copies nothing, passes the
caller's raw `struct iovec *` and stamps the pointer width — and the kernel
walks the caller's table through `msghdr::read_iovecs`/`gather`/`scatter`. No
new host import; no new kernel export.

Deleted from `kernel-worker.ts`: `#handleWritev`, `#handleReadv`,
`checkedProcessIovecs`, `processIovecLayout`, `checkedVectorCount`,
`joinPositionedVectorOffset`, two interfaces, six `PROCESS_IOVEC_WASM*`
constants, the hand-written process-address arm, and the vector cases of
`#scalarTransferSyscall`.

### The kernel already had a vector implementation. It had never run.

`channel_writev`, `channel_readv`, `channel_preadv` and `channel_pwritev`
parsed a `KernelIovecWire` table in kernel scratch — a table no host has ever
staged, because the TypeScript host rewrote every vector syscall to its scalar
twin before dispatch (`#scalarTransferSyscall`). Syscall numbers 81, 82 and
295–298 never reached the kernel at all. **Fourth instance of the
ported-but-unwired pattern** (§2u), and this one had four private adapters, a
`validate_special_layout` arm, and a source-shape guard in `crates/kernel/
src/lib.rs` asserting the adapters existed.

`runtime-core` had a *second* implementation — `sys_writev`/`sys_readv`/
`sys_preadv`/`sys_pwritev` over kernel-owned slices — which had all the tests
and no production caller. The two halves are now one `syscalls::sys_vector_io`
that takes the caller's guest address, and every vector test stages a real
iovec table in the mock host's guest memory. PIPE_BUF atomicity, datagram
boundaries, eventfd record atomicity, `RLIMIT_FSIZE`, `IOV_MAX`, ESPIPE, EBADF
direction and zero-length validation are now proven against the code that runs.

### A blocked `writev` retains its request. POSIX says why.

POSIX defines `writev` as `write` over the concatenation of the buffers and
bounds the return value by the sum of `iov_len` **as presented at the call**.
Kandelo re-enters a blocked syscall from the top, so a retry that re-read the
caller's table would let a peer thread change the request between attempts: a
widened `iov_len` makes `writev` report more than the caller asked for; a
narrowed one makes `readv` drop bytes already taken from a pipe.
`BlockingRetryTarget::Vector` holds the decoded table and, for a write, the
bytes gathered at entry. Replay is safe from double-writing because `sys_write`
returns a short count whenever any byte moved, so EAGAIN always means zero
progress.

### A genuine collision the K6 mechanism does not cover

`PROCESS_POINTER_WIDTH_ARG_INDEX` is channel slot 5, and for `preadv2`/
`pwritev2` slot 5 is the guest's `flags`. **It is load-bearing**: the campaign
status and the old code both said "pwritev2 flags remain ignored", but
`vectorRequestForbidsEagainRetry` reads `RWF_NOWAIT` out of it and suppresses
the EAGAIN park. Stamping the width over it would have silently turned a
non-blocking read into a parking one.

Resolved without new surface: the host reads `origArgs`, captured before the
overwrite, and the decision stays where the host already owns it — parking is
host policy. Recorded in `docs/abi-versioning.md`, and a new guard test pins
the set of kernel-dereferenced syscalls so the next addition has to answer the
same question. **Implementing real `RWF_*` semantics needs slot 5 freed
first** — see the open decision below.

### 2. The msghdr and iovec wires are retired

`KernelIovecWire`, `KernelMsghdrWire`, `KernelCmsghdrWire` and
`KERNEL_MESSAGE_WIRE_FLATTENED_IOVEC_COUNT` are gone, with
`validate_iovec_layout`, `validate_message_layout`,
`validate_message_wire_layout`, `lay_kernel_iovec_block`,
`lay_msghdr_subbuffer`, `iovec_syscall_is_output`, `write_scratch_u32` and
`KERNEL_WIRE_ALIGNMENT`.

Deadness was proven by the **use form**, not the name. The msghdr validators
were statically unreachable the moment K6 put `Sendmsg`/`Recvmsg` into
`SYSCALL_ARG_DESCRIPTORS`: `validate_channel_scratch_arguments` returns from
`validate_descriptor_layout` on a hit and only falls through to
`validate_special_layout` on a miss. The iovec validator became unreachable the
same way with this change. `KernelCmsghdrWire` had zero non-test consumers
already. The generated TypeScript twins had none outside tests.

The opaque transport still **decodes** IOVEC_ARRAY and MSGHDR spans — a format
reader must keep proving it reads the guest encoder's bytes — but preparation
refuses them with EINVAL rather than laying out a table, and the generated
guest marshal header no longer describes a nested iovec span for the six
syscalls, matching what K6 did for sendmsg/recvmsg.

### The wasmtime host was failing at the marshaller, and now is not

`crates/host-native`'s `marshal_in` bailed "unsupported arg size" on every
`KernelDereferenced` argument, so under that host `sendmsg`, `recvmsg`, the
SysV control calls and the mqueue transfers had been broken since K6 — and the
six vector syscalls would have joined them. Nothing needed staging: leave the
guest address alone and stamp width 4. Four lines.

### A POSIX fidelity defect the cutover surfaced, and the fixture that proved it

`guest_ptr::read_guest_bytes` / `write_guest_bytes` refuse guest address zero.
For a C pointer that is right — Kandelo's SDK never places an object at 0, so a
null `struct msghdr *` is a bug and EFAULT is what Linux reports. It is wrong
for an argument that is a raw memory OFFSET, and the deleted TypeScript
marshaller said so at the site: byte 0 of a guest's linear memory is an
ordinary addressable byte, and the range proof — not a null-pointer convention
— is what establishes that the caller owns it.

`host/test/fixtures/wasi-hello.wat` relies on exactly that, in as many words:
`;; Set up iovec at address 0`. A hand-written module has no C runtime holding
low memory back, and WASI's `ciovec.buf` is a wasm offset rather than a C
pointer. Moving the six vector syscalls onto the cross-memory primitives turned
that fixture's `fd_write` into EFAULT and took `test/wasi-module.test.ts` from
5/5 to **2/5**.

Resolved by splitting the policy rather than picking a side: `guest_ptr` gains
an `_at_any_address` pair — documented as its fourth rule — used only by the
iovec table and the buffers it names, while `read_msghdr`, the IPC control
paths and every other structure pointer keep the C convention. The host's
`host_proc_read_bytes`/`host_proc_write_bytes` allow address zero on the
PROCESS side for the same reason and stay strict on the kernel side, where zero
really does mean allocator failure.

**Worth noting how nearly this went the other way.** The first reading was that
the refusal was correct — Linux returns EFAULT for a null `iov`, and
`test/kernel-public-scratch.test.ts` had a case named "rejects null
positive-length process transfer ranges" pinning it deliberately. That reading
was reverted on principle and then reinstated on evidence, once a real in-repo
guest turned out to depend on the permissive behaviour. Principle and pinned
test both pointed the wrong way; the guest decided it.

### The blocked-retry defect, and K6's latent twin

`GENERIC_BLOCKING_SNAPSHOT_SYSCALLS` names the syscalls whose EAGAIN records
the frozen plan a retry replays. It listed **none** of the kernel-dereferenced
syscalls. The six vector ones used to take a `flattened-transfer` snapshot from
the host marshaller, and moving them to the descriptor path left them with
none: a blocked `writev` reached `handleBlockingRetry` with no frozen
disposition, which for a syscall that names a descriptor is a **fatal protocol
error, not a retry**.

`sendmsg` and `recvmsg` were in the same state and had been since K6 moved
their `msghdr` to the same form. Nothing in that item's suites blocks, so it
never fired. All eight are added.

### `EXPECTED_HOST_IMPORT_COUNT` still said 75

`crates/host-native` pins the kernel's `env.host_*` import count. The campaign
has been at 76 since K7 gave `host_debug_log` a live caller; the pin was never
updated. It survived because the test that reads it **skips when no kernel
artifact exists** — every fresh worktree. Building a kernel is what makes it
fire, and this item built one.

### The eighth silent-success defect: 20 tests that run on no target

**Every `#[test]` in `crates/kernel/src/wasm_api.rs` is unreachable.** The
module is `#[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]`, and
the kernel is only ever *built* for those targets, never tested. `cargo test -p
kandelo` runs 3 source-shape guards from `lib.rs` and 4 from `tests/`; the 20
`#[test]` functions inside `wasm_api.rs` are compiled by nothing. One of them
was the iovec-count boundary test this item inherited. Coverage that needs to
run belongs in `runtime-core`.

### The tenth, and the expensive one: guest tests resolve a DIFFERENT kernel

`local-binaries/kernel.wasm` is the ambient path the campaign's notes name, and
`install-local-artifact` is how you refresh it. But the resolver checks
**`local-binaries/source-only-v1/` first**, so a stale kernel there wins over a
freshly installed ambient one, silently.

`scripts/xtask.sh verify-fresh` reports this precisely — "…/source-only-v1/
kernel.wasm is stale: it was built for key …, but the current source tree
resolves to key …". It was read as being about a tier nothing used, and every
Vitest result for the next two hours ran against a kernel two hours older than
the tree. The tell was a kernel-side probe that produced no output at all: an
`ENOTTY` planted in the dispatch arm never came back, for the *passing* cases
as well as the failing ones.

`./run.sh rebuild kernel` is what refreshes that tier. Do it, then re-run
everything measured before it.

### The ninth: `npx tsc` exits 0 without compiling

In a worktree with no `node_modules`, `npx tsc --noEmit -p host` prints
"This is not the tsc command you are looking for" and **exits 0**. Read as
"0 errors" for about a minute. Use `host/node_modules/.bin/tsc`.

### Validation actually run

Everything below is against a kernel rebuilt through `./run.sh rebuild kernel`
into `local-binaries/source-only-v1/` — the tier guest tests resolve — after
musl was rebuilt for both widths from the regenerated headers.

| evidence | result |
|---|---|
| `cargo test -p runtime-core -p kandelo -p wasm-posix-shared -p host-native` | green (1,895 + 3 + 4 + 64 + 52 + 1) |
| `cargo test --workspace --exclude xtask` | green, 0 failures |
| `cargo test -p xtask` | 605 + 1 + 2, green |
| `cargo check` **wasm32** and **wasm64** (`-Z build-std`) | 0 errors each |
| **`kernel-scratch-runtime` (the vector conformance program)** | **2/2, wasm32 AND wasm64** |
| `wasi-module` (fd_write / path_open+fd_read / fd_readdir) | 5/5 |
| `rlimit-fsize`, `sysv-ipc`, `mqueue`, `scm-rights-semantics`, `scm-rights-pipe-lifetime` | 31/31 together with the two above |
| `ifhwaddr` | 2/2 **run alone**, as K6 recorded |
| contract + boundary set (8 files) | **454 passed / 5 failed**, every failure proven pre-existing |
| POSIX I/O + signal suites (9 files) | 47/48; the one failure identical at base |
| process/fork/exec/spawn/wait/clone (75 files) | 580 passed / 45 failed; base has **46** in the same five files |
| `host/node_modules/.bin/tsc --noEmit -p host` | 33 errors, identical count at `020d1dbfa` measured the same way |
| `scripts/check-abi-version.sh` | snapshot in sync; ABI_VERSION and snapshot consistent |
| `scripts/xtask.sh verify-fresh` | clean |

The five pre-existing failures, each proven rather than assumed:

- 3 × `kernel-scratch-contract` — byte-identical messages at `020d1dbfa` from a
  detached checkout, including the 30-entry unreviewed-memory-authority list.
- `kernel-large-transfer-protocol` "fatal latch" — the harness stubs
  `kernel_commit_process_exit` while the host uses
  `kernel_commit_process_group_exit` for `exit_group`, introduced by `7e7a010c8`
  which `git merge-base --is-ancestor` confirms predates this base.
- `kernel-scratch-transfer-boundaries` epoll padding — reproduced with the base
  `host/src/kernel-worker.ts` restored over this tree.

**No full-suite number is claimed.** This worktree is not fully provisioned:
the musl-level change invalidated every package, and the 97-package rebuild was
stopped at 12 after ~20 minutes. A full run reports 43 failing files whose
causes are dominated by that — `Package artifact closure is incomplete`,
`dash.wasm` ENOENT, `fork-instrumented worker requires the co-resident fork
module`, `BrowserKernel test should not fetch`, and 54 timeouts on a loaded
machine. None of them names a vector syscall: a search of the complete log for
`writev|readv|preadv|pwritev|iovec` finds only passing cases and live syscall
traces such as `[100] writev(1, 9537856, 2) = 46`.

**Browser: not run.** The consolidated tier-end pass and the maintainer's own
manual check still owe this change.

## Validation traps this campaign has paid for — read before claiming a green

**Seven silent-success defects, each found by someone about to cite it as evidence.**
The pattern is consistent enough to be a standing suspicion rather than a run of
accidents: **when a gate reports success, check that it ran.**

1. A rebuild that did not rebuild (`./run.sh rebuild kernel` leaves ambient
   `local-binaries/kernel.wasm` stale).
2. `vfs-image-kernel-lazy`'s KLZY equivalence gate scoring a skip as a pass.
3. `build-musl.sh` exiting 0 on failure.
4. **All 18 real-`dlopen` e2e tests skip unless `local-binaries/kernel.wasm`
   exists**, which `./run.sh setup` never creates — a fresh worktree reports
   `3 passed | 3 skipped`, exit 0, beside 100 green unit tests. The gate
   guarding a 6,340-line deletion was armed to pass by default. True baseline:
   **116 passed / 2 failed of 118**.
5. **`cargo test -p wasi-module` ran 0 tests, exit 0** — `#![cfg(feature = "testing")]`
   with nothing enabling it. Those 60 tests were the only coverage of 40 of the
   46 WASI entry points.
6. `host/test/pthread.test.ts` dying wholesale on a missing `rootfs.vfs`, hiding
   a genuinely red thread-exit test for an unknown length of time.
7. **`ci-check-browser-assets` asking only three hardcoded questions.** It does
   `process.exit(1)` on failure, so it is not swallowing errors — its *spec
   list* was hardcoded, so it could never fail on a missing co-resident side
   module. Green for `@fork-module32-wasm` for as long as that alias existed.
   Now sourced from `browser-module-contract.mjs`.

### Two mitigations that looked applied and were not

Both produce cross-worktree side effects, and both produce failures naming
neither worktree — which is what makes them expensive rather than annoying.

- **`KANDELO_SOURCE_CACHE_ROOT` was stripped by
  `nix develop --ignore-environment`** while every agent brief mandated setting
  it. So no agent ever had cache isolation, and the campaign's own
  kernel-install recipe installed nothing when invoked the obvious way. Three
  agents found it independently, from three different symptoms. Fixed.
- **The per-session scratchpad is shared between concurrent agents.** One agent
  wrote a helper script there; a sibling replaced it between write and execute,
  and the script that ran `cd`'d into the sibling's worktree and refreshed its
  `kernel.wasm`. Later confirmed from the other direction: a sibling's
  `./run.sh setup` writing its log into that agent's scratchpad. **Defensive
  pattern:** a uniquely-named file *plus* an in-script guard asserting the
  expected worktree — a unique name alone does not help, because the failure is
  a replacement between write and execute.

### Two more that cost whole test runs

**The full Vitest suite needs an otherwise-idle tree.** Two agents discarded
complete runs they had destroyed themselves — one with a concurrent
`./run.sh rebuild kernel` (which removes the ambient kernel), one with
`check-abi-version.sh` (which rebuilds the kernel wasm and republishes the
program index). The tell is identical in both: suites that pass in isolation
appear in the failing set, with errors naming *provisioning* rather than
behaviour. **Do the builds first, then run the suite and touch nothing.**

**Run Vitest inside `./scripts/dev-shell.sh`.** Outside it the SDK is not on
PATH and ~80 unrelated failures appear (`wasm32posix-cc ENOENT`, "no
wasm32-capable clang"). The coordinator made this mistake once and reported
real-looking failures from it.

**And a native-only `cargo check` is not evidence a crate builds.** A `String`
resolving through `std` on the host failed on wasm32/wasm64 twice this week,
where `runtime-core` is `no_std` and must name it through `alloc`.

## Every in-scope item is now done or in flight (2026-09-10)

| In flight | What it is |
|---|---|
| K4a continuation | 39 remaining differing worker-entry pairs, ~3,430 lines |
| K5 I6a | The dylink module + 14 pipeline points; unblocks a 6,340-line deletion |
| `pathconf`/`statfs` + `trap-signals` | 4 host imports (75 → 71); host-native gains signal mapping |
| K13b | ~116 of ~305 kernel exports |
| `constants.ts` | 3,031 lines; the false-KEEP correction |

Nothing in scope is unstarted. The remaining work after these land is the
**deletion debt they unblock** (K5 I6b's 6,340 lines above all), the
**tier-end browser pass**, and the **tier-end reconciliation** of two items
deliberately held because their files were being rewritten: the 16 remaining
unreviewed kernel-memory-authority sites in `host/src`, and ~30 stale "ABI 43"
strings in error messages that need per-site judgment (some describe what ABI
43 genuinely did and are still true; replacing those would introduce
falsehoods while claiming to remove them).

Then, per the maintainer's standing instruction, a **fresh census** over the
same scope — not a wrap-up, a re-ask of what should be migrated, reduced or
removed, followed by work on whatever it finds. The mid-campaign census run
early found six uncovered items and a false KEEP in our own ledger, so the
end-of-campaign one is not expected to come back empty.

## A design collision, not a merge conflict (2026-09-10)

K10 I6 and K5 I6a **independently generalized the same pipeline**, in parallel,
for the same reason. Each needed a second module built, projected and
freshness-checked; each refused to copy fork-module's ~250 lines; each turned it
into a table. K10 produced `CORESIDENT_SIDE_MODULES`, K5 produced
`STANDALONE_MODULES`, both in `tools/xtask/src/local_build.rs`.

Cherry-picking the second produced **30 conflicting hunks** — competing
abstractions, not textual drift.

**The coordinator did not resolve it.** Choosing an architecture from inside a
conflict marker is the wrong place to make that decision: neither side's
reasoning is visible there, and whichever half survives does so for merge-order
reasons rather than design ones. The merge was aborted, the branch left clean at
`0d443572b`, and the item handed back to the agent that holds the context, with
the incumbent named (`CORESIDENT_SIDE_MODULES` is merged and ships the WASI
module today) and the constraint stated: one table, three modules, and do not
regress K10's four browser registration points.

**The generalizable lesson:** parallel agents converging on the same
abstraction is a *success signal* — two independent designs agreeing that a
table is the right shape is stronger evidence than either alone. But it arrives
disguised as a conflict, and the merge tool presents it at exactly the moment
and place where it is hardest to judge. **Merge-order is not an architecture
decision.**

### Eighth silent-success defect, found by the same agent

**fork-module's `--verify-fresh` exited 0 when the artifact did not exist.** So
the auto-build never fired, and fresh worktrees died later at finalization
telling the developer to run the build script by hand. A freshness check that
passes on a missing artifact is the purest form of this campaign's recurring
defect: the gate reports success because it never looked.

## The SysV regression's cheap remedy — analysed, not yet applied

K7 measured a **3.7× regression** on a clean shared-mapping boundary with a
live peer (793 µs → 2,965 µs) and named a remedy needing no import:
`host_proc_read_bytes` "copies its range twice and allocates per call".

**Confirmed, at `host/src/kernel.ts:2598-2599`:** `sliceUint8Array(processView)`
allocates a new array and copies the whole range, then `#writeKernelBytes`
copies it again into kernel memory. Two copies, one allocation, per call.

**But the intermediate is not gratuitous, and this is the part K7's summary did
not have.** The sibling write path carries the reason explicitly
(`kernel.ts:2549`): *"Reacquire the process buffer after copying the kernel
source: another process worker may have grown it in the meantime."* Growing a
`WebAssembly.Memory` replaces its `.buffer`, detaching every view taken before.
The slice takes its snapshot **early**, before `#writeKernelBytes` does its
WeakMap lookup, range check and length validation — so it narrows the window in
which a concurrent grow can invalidate the source view.

**Removing the slice naively would widen that window**, trading a measured
throughput problem for an unmeasured correctness one on a concurrency-sensitive
path. That is the wrong trade.

**The correct shape is the one the write path already uses:** hoist all
destination validation *before* the source view is created, then create the
view and copy immediately — one `set()`, no allocation, and a window no wider
than today's.

**Not applied here, deliberately.** The performance contract requires
before/after evidence, and K7's targeted shared-mapping benchmark lives in its
worktree; a general syscall benchmark exercises only the early-out and cannot
see this path at all. **This should be done with that benchmark in hand, not
before it.** The analysis above is the item — the next agent should not
re-derive why the slice exists.

**And it should be tried before spending `host_proc_compare_bytes`.** The
sanctioned import is now evidence-backed, but a fix costing zero imports
deserves to fail first.

## Fresh-worktree provisioning — the full list, because `setup` does none of it

Assembled from three agents that each hit the next step only after clearing the
previous one. **`./run.sh setup` performs none of these**, and each turned
*erroring* test files into *executing* ones — which is why omitting one reads as
a broken feature rather than a missing artifact.

1. musl wasm32 **and** wasm64 sysroots
2. `npm --prefix host install` — vitest is a `host/` devDependency
3. **`npm ci` at the repository root** — without it `rootfs` and
   `node-browser-bundle` fail on a locked `tsx` CLI, and `rootfs` failing
   **cascade-blocks every browser product**
4. `crates/fork-module/build-wasm.sh` — missing `fork_module32.wasm` fails
   `coreutils-docs`, which blocks **six of nine images**
5. a kernel build — and this needs **both** halves, for a reason that has now
   cost two agent-hours:
   - `./run.sh rebuild kernel` refreshes **`local-binaries/source-only-v1/kernel.wasm`**
   - `build-deps … install-local-artifact` refreshes **ambient `local-binaries/kernel.wasm`**

   **The resolver tries `source-only-v1` FIRST** (`binary-resolver.ts:291`,
   ordered `source-only-v1` → `local-binaries` → `binaries` → installed
   package). So `install-local-artifact` alone refreshes the copy the guest
   tests do **not** read, and the tests keep running yesterday's kernel while
   the command reports success. Run both, in that order.

   **`verify-fresh` says this exactly, naming both keys.** Two agents —
   including the coordinator — have discounted that message rather than read
   it. It is the ninth and tenth instance in this campaign of a gate being
   right and ignored, which is a different failure from the eight gates that
   were wrong.
6. `./run.sh rebuild rootfs`
7. `scripts/build-programs.sh` — without it `spawn-pid-authority` and
   `vfork-lifecycle-guest` fail at **collection**, contributing zero executed
   tests while appearing merely "failed"

**Two suites were contributing nothing all along.** `vfork-lifecycle-guest` is
the only suite that exercises `containVforkAddressSpace`; it had never run.
That is the same "green means nothing ran" shape as the seven silent-success
defects, wearing provisioning clothes.

Once provisioned, three previously-blocked guest suites passed —
`environment-lifecycle`, `fifo-lifecycle-guest`, `wait-lifecycle-guest` — real
guest programs forking, exec'ing, blocking on FIFOs and reaping children
through the shared `finishProcessExit`. Worker-lifecycle standing went from
**209/3 to 212 passed / 0 failed** of the tests that execute.

## A second design collision, handled the same way

K8 increment 2 and K9 both restructured `crates/runtime-core/src/rootfs.rs`.
K9 added a `MountRoots` registry — *"deliberately independent of
`ForeignMounts`"*, because which paths are host-owned and which host directory
anchors a path are different questions. K8's
`ensure_foreign_mount_parents`/`mkdir_parents` rewrote overlapping code.

The conflict's two halves **each carry an unbalanced brace** — both cut through
a function body — so neither "keep both" nor "take one" compiles. That is
entanglement at the design level, not textual adjacency. Aborted and handed
back, as with the K5/K10 pipeline-table collision, with the behaviour to
preserve named explicitly rather than the code shape.

**Twice in one session.** When several agents restructure one subsystem in
parallel, expect collisions in the *shared foundation* files rather than in the
leaf files each was assigned — `local_build.rs` and `rootfs.rs`, not the
subsystems themselves.

### CORRECTION: the `rootfs.rs` collision was textual, not architectural

The coordinator read "each half carries an unbalanced brace" as entanglement at
the design level. **It was not.** K9 and K8 each inserted a block into the same
gap, and **each half lost its closing brace to the other** — which is what
produces the unbalanced-brace signature. Giving each block its brace back and
keeping both compiles. The same shape recurred twice more in the rebase: two new
exports in one gap in `wasm_api.rs`, and two names in one sorted list in
`kernel-scratch.ts`.

So the diagnostic is weaker than it looked: **an unbalanced brace on both sides
means the conflict cut through a function body, not that the two changes are
entangled.** Handing it back was still right — the agent held the context and
resolved it in minutes — but the *reason* given was wrong, and a coordinator
using that signature to route work would misroute it.

**K8 also declined to move `ensure_foreign_mount_parents` onto K9's registry,
with a better argument than the one in the brief:** reachability is *which paths
exist in the kernel's namespace*, not *where a mount's bytes come from*. A mount
point must be walkable even when no handle was ever published for it, and
driving it from the handle registry would impose exactly the publication order
`MountRoots` documents itself as avoiding.

## K4a complete — and the validation number only means something because of provisioning

**21 of 38 worker-entry pairs unified**, ledger **−80 TS**. The agent
re-measured the census with its own extractor rather than adopting the brief's
figures, reported the difference (38 pairs / 3 identical / 35 differing versus
13/3/39) and said the counting differed while the conclusion did not.

**Worker-lifecycle: 236/236 across 23 files, no skips.** That number is only
meaningful because `vfork-lifecycle-guest` and `spawn-pid-authority` had been
failing at *collection* on a missing fixture — **contributing zero executed
tests, at base as well as at tip**. They cover this pass's riskiest change, and
the six vfork tests now executing include the ones driving the shared
`containVforkAddressSpace` and the shared `finishProcessExit` — the two changes
the agent had explicitly flagged as reasoned-but-unexecuted.

**One boundary declared rather than collapsed**, which is the right instinct:
`defaultExitCrashSignum` stays host-specific because the synthesized reap is a
*callee* responsibility in the browser and a *caller* responsibility on Node,
and unifying it would change Node's worker-`exit` path in a way the Node suites
cannot prove. Sharing code you cannot test the effect of is not sharing.

**It also corrected one of its own reports mid-run**: it had called
`./run.sh setup` successful on a notification's exit 0 when the build exited 1,
because its command chain ended in `tail`. **That is the same false green the
coordinator hit earlier in this campaign** — the harness reports the last
command's status. No test claim depended on it, and it flagged the error rather
than letting it stand.

### NEEDS-DEFER-DECISION (NDD-K4-2) — the last 16 pairs

They are **one fork/exec/clone/init family, ~2,700 node lines, and cannot be
split**: each constructs or tears down a process generation, so all need the
same ~3 new host hooks. Three together buy the hooks once; one alone saves
almost nothing. Recommendation: take it as a single item, with the fork-path
guest suites provisioned *first* — this pass proved those suites were dark.

## Tier-end reconciliation — done, and three corrections to what it was thought to be

`usePolling`, the 16 memory-authority sites and the stale "ABI 43" strings are
executed. Three of the figures this document carried were wrong, and each was
wrong in a way worth recording rather than just fixing.

**"Six test files set `usePolling: true`" was right; a later census saying
"one" was wrong.** The census grepped `= true` and missed
`usePolling: true` inside `Object.assign`, which is how all seven of the real
assignments are written. A count of an identifier must match every syntactic
form the identifier is assigned in.

**"Three stale ABI 43 strings in `kernel-worker.ts`" was right; a later census
saying "none" was wrong, and for a reusable reason.** One of the three is
spelled `ABI-43` with a hyphen, so a `grep "ABI 43"` census cannot see it.
`grep -E "ABI[ -]43"` finds twelve remaining sites across `host/src`, not ten.

**"16 unreviewed kernel-memory-authority sites, reach 8/8" was wrong twice
over.** The audit had **36** findings: 21 unreviewed sites, 13 allowances whose
sites this campaign had moved or deleted, and 2 ownership seeds naming an
interface that had been hoisted into `process-lifecycle.ts`. And 8/8 was never
reachable by allowlisting, because two of the three failures were not audit
findings at all.

**Two of the 21 "sites to review" were provability bugs, not sites.** The
record path omitted `#executeCapacityOwnedChannel`'s defaulted `retryToken`, and
the audit's exact-arity check therefore could not prove the lease transaction —
six findings from one missing argument. `handleExit` selected its commit export
by indexing the exports namespace with a computed name, so a scalar call was
classified as a pointer bypass. Both were fixed by making the existing property
provable rather than by recording an exception to it. **When a review gate
flags code that already looks compliant, suspect that the gate cannot see the
proof, before concluding the code is wrong.**

### Still open: `#sysvMirrorExports` returns scoped entry authority

`kernel-scratch-contract` is 7/8. The last failure is
`context-return at CentralizedKernelWorker.#sysvMirrorExports`: the method
resolves nine SysV mirror exports from `#kernelInstanceForEntry(entry)` and
**returns them as a bundle**, so raw kernel export functions outlive the entry
scope by shape. All eight call sites invoke members immediately and none
retains the bundle, so nothing is wrong today.

The two remedies are not equivalent and the choice is a maintainer's:

- Add `#sysvMirrorExports` to the audit's `ENTRY_SELECTORS`. Cheap, but it
  edits the gate to accept the code — the inverse of the two fixes above, and
  the shape this campaign has been burned by ten times. It also widens a set
  that today holds only the two instance selectors to include a nine-function
  export bundle.
- Convert it to a callback form so the exports never escape. Correct in
  direction, but it touches eight call sites on the SysV shared-memory path,
  and it is not obvious the entry-context audit models a new callback helper
  any better than it models the current return — so it could be a real
  refactor that does not clear the finding.

**Cost of leaving it:** one known-red assertion, which erodes the gate's
signal. **Cost of guessing:** a wrong refactor on shared-memory teardown.
Recommendation: the callback form, but scoped as its own item by whoever owns
the entry-gate contract, with the audit change (if any) argued explicitly.
## NDD-K4-2 executed — the launch family is one implementation

**Ledger −919 TS.** The two entries went from 2,748 and 3,371 lines to 2,173
and 2,579.

### The census: neither 16 nor 21, and the difference is what was counted

Measured with an extractor over both entries rather than adopting a figure:
**at the campaign base, 46 declarations were common to the two files — 20
byte-identical, 26 differing.** At this commit it is **36 common, 16
identical, 20 differing.**

Both earlier counts — the brief's 16 and the later correction's 21 — counted
only *functions*. A third of the shared surface is `const`/`let`/`type`
declarations the two files also write twice: `processes`, `vforkLifetimes`,
`externrefProcessOwner`, `processTeardowns`, `processMemoryCreators`,
`maxPages`, `defaultThreadSlots`, `nextProcessGeneration` and more, most of
them byte-identical one-liners. They are not free — each is state the shared
module receives through the host record, so moving them means constructing
them inside `createProcessLifecycle` and handing them back. That is a real
reduction still on the table, and a different shape of work from the family
below.

The correction's other claim was right and worth keeping: **"cannot be split"
was never true of the whole set.** The trap trio (`classifyWasmTrap`,
`classifiedSignalOrFallback`, `classifiedTrapExitStatus`) construct no process
generation and needed no hook at all.

### Nine declarations shared

`ProcessInfo` and `ForkReplayContext` (the two entries' records were
field-for-field identical apart from the worker handle), `handleSpawn`,
`handlePosixSpawn`, `handleOrdinaryFork`, `handleVfork`, `handleClone`,
`handleExit`, `handleFork`, and the trap trio.

`ProcessLifecycleInfo` is now generic in the **worker handle**, not in the
record. That is what lets shared code *build* a generation instead of asking
each host to. Four fields that had looked browser-only are host-independent
concepts Node simply never had to falsify: `generation`, `memoryRetirementSafe`,
the alias-exposure pair (renamed off `framebuffer*` — the shared record has no
business knowing the browser's alias is a framebuffer), and `argv`.

### Three POSIX drifts closed, each toward the correct half

- **A dead `posix_spawn` child was never reaped on Node.** When the kernel
  reports the child already dead — killed between `kernel_spawn_process` and
  the worker start — the browser passed the finalized signal into
  `awaitFinalizedProcessTeardown` so `finishProcessExit` synthesized the
  signal-style reap. Node passed none, and its `defaultExitCrashSignum` is
  deliberately undefined, so **no reap was synthesized at all**: a parent
  already inside `waitpid` had nothing to observe until destroy. Same gap in
  `handleOrdinaryFork` and in both of `handleVfork`'s dead-child paths.
  `notifyHostProcessCrashed` is guarded by `hostReaped`, so taking the correct
  half costs nothing where the kernel had already marked the zombie.
- **`maxPages` was ignored on Node** — the entry always used the kernel
  default, a POSIX-visible difference in what a spawn request may ask for. The
  shared `createFreshProcessMemory` already accepted it; only the call site
  did not pass it.
- **`cwd` never reached the Node worker.** The browser put it in the init
  message; a Node guest reading its working directory before its first `chdir`
  saw the kernel default rather than the directory the launch had named.

A fourth is a protocol refusal rather than POSIX: Node rejected a spawn naming
both `programBytes` and `programPath`; the browser silently preferred the bytes
and dropped the path, so a caller that got the pair wrong was told it had
succeeded.

### `terminationProvesQuiescence` is now consumed, not just declared

The previous pass declared it with an explicit note that nothing branched on
it. `handleClone` now derives both of its host asymmetries from it — thread-slot
reclaim, and the `memoryRetirementSafe` fallback when a worker was terminated
without publishing `memory_quiescent`. Node remains the host whose predicate
always holds, not the host with a shortcut.

`exitRetirementFences` is gone, replaced by the narrower
`releaseGenerationAliases`. It had folded the host's alias release together
with `memoryRetirementSafe`; with that flag on the shared record, the exit
predicate — and the identical one in every construction rollback — is written
once.

### Boundaries declared rather than collapsed

Seven, each a real platform difference: the worker constructor
(`createProcessWorker`, `createDeferredProcessWorker`, `createThreadWorker`),
`sideModuleInitFields` (Node compiles side modules off disk, the browser
receives them compiled), `decorateLaunchEnv` (the browser injects its TLS-MITM
CA path because guest TLS verifies through proxied egress),
`onProcessPtyReady` (Node registers the PTY output callback at spawn; the
browser's main thread asks separately with `register_pty_output`), and
`awaitProcessConstructionBarrier` — vacuous on Node because `terminate()` is an
ownership fence, load-bearing in the browser because it is not.

`defaultExitCrashSignum` stays declared, as adjudicated. The dead-child fix
above is not a collapse of it: that caller *knows* the exact signal the kernel
finalized, which is better than either host's default, so there was nothing to
adjudicate.

`LifecycleWorker` was too narrow to keep. Watching a fork child reach its
copied activation needs the worker's message surface, not just `terminate()`,
so the module's parameter is constrained to `WorkerHandle` — exactly what both
adapters already return. It constrains nothing new; it stops the module
claiming it touches less than it does.

### A test seam that sharing would have silently disarmed

Moving the deferred-worker construction behind a hook left the browser's
`KANDELO_TEST_VFORK_WORKER_START_FAILURE` switch set by nothing that read it —
a fault injection that would have reported success while injecting nothing.
That is the eleventh silent-success shape in this campaign, and it was
introduced *by* the refactor rather than found in it. It now lives in the hook,
gated on `purpose === "vfork"` so it stays scoped to the rollback it exercises.

### Structural assertions: 17 repointed, each still checking its subject

Across seven suites. Checking the shared copy is **stronger** than checking
two — a ledger route, a diagnostic, an ownership fence or a generation identity
can no longer hold on one host's path and be missing from the other's — so each
repointed assertion is paired with a binding check on both entries. Sharing a
function must not read as deleting it.

Two slicing helpers stopped naming a neighbouring function to bound a slice.
Both files already carried a comment explaining why that is wrong — moving the
neighbour turns the slice into `-1` and fails a test whose subject has not
changed — and both then did it anyway. They now bound at the next declaration
at the start marker's own indent, which serves a top-level entry function and a
function inside `createProcessLifecycle` alike.

One assertion legitimately changed scope: "browser posix_spawn rollback owns
the allocated newMemory identity" was browser-only because only the browser's
copy had named its allocation `newMemory` and awaited the alias release. With
one implementation it covers both hosts.

### Validation actually run

All inside `./scripts/dev-shell.sh`, with `host/node_modules/.bin/vitest` —
**not** `npx vitest`, which resolves a different vitest out of `~/.npm/_npx`
and fails at startup on a reporter it cannot load. That is a twelfth "the gate
did not run what you think" shape, and it announces itself loudly rather than
passing, so it cost minutes rather than hours.

- **6 structural parity suites: 43 passed of 43.** The primary gate. All six
  were red before the assertions were repointed — 14 failures, every one a
  slice of a function that had moved, none of them a changed subject.
- **23 worker-lifecycle/entry suites: 215 executed, 200 passed / 15 failed,
  no skips.**
- **9 host-parity/contract suites: 62 executed, 59 passed / 3 failed.** All
  three failures are `kernel-scratch-contract`, the documented
  unreviewed-memory-authority case.
- **`npm --prefix host run typecheck`: 9 errors, the baseline**, with the only
  `host/src` one being the known TLS `BodyInit` case.
- Ledger `--step e93167651 HEAD`: **−919 in-scope TS**, 0 Rust.

**The 15 worker-lifecycle failures are pre-existing, and that is measured
rather than asserted.** They sit in five files — `environment-lifecycle`,
`ordinary-process-exit`, `process-wait-lifecycle`, `spawn-credential-order`,
`spawn-pid-authority`. Those five were re-run against the campaign base's
`host/src` and `host/test`, restored into this fully provisioned worktree, and
produced **15 failed / 85 passed of 100 — the same files, the same cases**.
The tip produces the same 15 of the same 100. One tip-only failure existed
before that comparison and was a structural assertion, now repointed.

**This does not match the previous pass's "236/236 across 23 files."** Two
explanations are consistent with the evidence and I cannot separate them from
here: the 23 files are probably not the same 23 (this set was chosen by
subject, not inherited), and the ABI-marker gap below fails suites in any
worktree provisioned by the documented steps. Reporting the number I measured
against a base I measured, rather than reconciling to a number I could not
reproduce.

**Browser: NOT run**, and this is the first of the two kinds the brief
distinguishes. Everything shared here constructs or tears down a process
generation — fork, vfork, clone, spawn, exec-adjacent exit — so it needs the
app booted, real Workers, and real guest programs. An engine-only check would
prove nothing about it. The browser-half changes needing that pass are: the
construction barrier now reached through `awaitProcessConstructionBarrier`, the
alias release through `releaseGenerationAliases`, the vfork fault-injection
seam's new `purpose` gate, and the `framebufferExposed`/`framebufferRelease`
rename. The Node suites cannot reach any of them.

### Three concurrent agents, three worktrees, one disk

Three vitest runs were in flight during this pass, in
`agent-a547ca4cce7d17e0a`, `agent-a4fa57a74a2c1712a` and here. File isolation
held — each worktree has its own `local-binaries` and `host/wasm` — but they
share the machine and `~/.cache/kandelo`. The plan's "otherwise-idle tree"
rule is about the tree; it is worth adding that a busy *machine* stretches the
kernel-booting guest suites enough to matter, and that the shared cache is
where the disk goes.

### NEEDS-DEFER-DECISION (NDD-K4-3) — what the launch family left behind

Twenty differing declarations remain. They are **not** one item, and the
"cannot be split" framing should not be inherited a third time. They fall into
three groups with genuinely different costs:

**1. `handleExec` (459 node / 494 browser).** The last member of the launch
family proper, and it should follow the others: it constructs a replacement
generation, so the hooks are already paid for. It was left out of this pass for
schedule, not for difficulty. *Cost now:* comparable to `handleVfork` — a
careful session. *Cost later:* it is the one remaining place a construction
drift can reappear, and this pass found three such drifts in its siblings.
*Recommendation:* take it next, on its own.

**2. `handleInit` (267 / 504) and `handleHttpRequest` (15 / 53).** These are
**not** the same shape. The browser's init compiles side modules shipped from
main, wires a service-worker bridge and a CORS proxy; Node reads files and
opens a session directory. The size ratio is a real host difference, not
drift. *Recommendation:* extract the genuinely common middle — kernel
construction, the callback record, the rootfs/overlay wiring — and leave the
artifact acquisition on each side. Do not force the whole function.

**3. `installProcessWorkerListeners` (98 / 187) and `performDestroy`
(133 / 143).** Both tear down generations, so both are within reach of the
existing hooks, and `performDestroy`'s two halves are close. The listener
installer's 89-line gap is where the browser fabricates the `exit` event its
`terminate()` never delivers, which is the terminate-fence boundary again and
may be partly irreducible. *Recommendation:* `performDestroy` with `handleExec`;
`installProcessWorkerListeners` after, once the fence-derived shape from
`handleClone` has been exercised.

**And the group nobody has counted: the state declarations.** Sixteen
byte-identical `const`/`let` declarations the two entries both write —
`processes`, `vforkLifetimes`, `externrefProcessOwner`, `processTeardowns`,
`processMemoryCreators`, `forkHostImportOwnerRuntime`, `nextProcessGeneration`
and the rest. Each is passed straight back to `createProcessLifecycle` through
the host record, so moving them means constructing them inside the module and
returning them — which also **shrinks `ProcessLifecycleHost`**, the campaign's
actual north star, rather than only shrinking line counts. `threadModuleCache`
and `threadedProcessPids` moved that way in this pass and cost nothing.
*Recommendation:* do this before group 2. It is the cheapest remaining
reduction and the only one that narrows the host contract.

### Two environment findings that change how a baseline should be read

**`KANDELO_SOURCE_CACHE_ROOT` does not isolate the programs cache.** With it
set to a private root for a whole provisioning run, that root held **1.2 MB**
while `~/.cache/kandelo` — shared by every worktree and every concurrent agent
— held **237 GB**, and the package build logs named it throughout. The
directive is worth keeping, but it does not deliver the isolation the campaign
notes claim for it, and an agent told to set it should not conclude it is now
insulated from a sibling's cache.

**The host filesystem reached 100% (238 MiB free) during this pass**, and sat
under 1 GiB for much of it. The plan already says the full suite needs an
otherwise-idle tree; it needs a tree with disk headroom too. Two consequences
matter for reading any number measured under that pressure: a `nix develop`
invocation failed with a shell syntax error caused purely by a failed cache
write, and absolute pass counts are not comparable across the boundary. A
before/after comparison measured minutes apart under the *same* pressure is
still sound, which is why the base-versus-tip comparison below is the claim
being made rather than an absolute figure.

### `build-programs.sh` fixtures do not carry the ABI markers

`ordinary-process-exit` fails because the worker prints two warnings to
stderr for `local-binaries/programs/wasm32/exec-child.wasm` — "lacks
`__abi_version` export" and "lacks a `kandelo.abi.contract` stamp" — and the
test asserts stderr is empty. The fixture is **not stale**: it was written by
`scripts/build-programs.sh` minutes earlier. The stamp comes from the
local-build engine, which that script does not run, so every worktree
provisioned by the campaign's own documented steps produces fixtures the
worker's ABI checks warn about.

This is **not** a reason to weaken the check. It is a gap between two build
paths for the same class of artifact, and it should be closed by teaching
`build-programs.sh` to stamp, not by teaching the worker to stay quiet.

## K3 §11.2 `usePolling` — adjudicated on the platform contract, ready to execute

**Verdict: delete it.** Not because nothing uses it — the disposition ledger's
§3 says explicitly that "nothing uses this" is not a reason — but because it
exists to serve a deployment the platform contract **forbids**.

Its own documentation (`kernel-worker.ts:14915-14921`) says: *"This remains a
legacy opt-in for browser embeddings that run the kernel **on the main
thread**. The dedicated browser worker and Node.js both keep the default
event-driven `Atomics.waitAsync` mode."*

`CLAUDE.md`'s Host Runtime Contract says: *"The kernel must run in a dedicated
worker on every host. `CentralizedKernelWorker` must not be instantiated on the
main thread."*

So the polling path is a fallback for a configuration that is not merely unused
but **prohibited**. That is a contract-based justification rather than a
usage-based one, which is the distinction §3 exists to enforce.

**Measured surface:** the field defaults to `false`
(`kernel-worker.ts:14922`); **nothing in production ever sets it `true`**; two
sites set it to `false` **redundantly** (`browser-kernel-worker-entry.ts:993`,
`network-demo-worker.ts:230`). Four `if (this.usePolling)` branches, plus
`pollMC`/`pollScheduled`/`pollLastYield`, `startPolling`, `stopPolling`,
`pollTick`, `schedulePoll`. Six test files set `usePolling: true` and exercise
the poller — coverage of a path that cannot run in a conforming host.

**Not executed yet, and the reason is scheduling rather than doubt:**
`kernel-worker.ts` is being rewritten by several agents right now, and this
deletion spans that file plus six test files. The adjudication above is the hard
part; the edit is mechanical. **Owner: coordinator, with the tier-end
reconciliation**, alongside the 16 memory-authority sites and the ~30 stale
"ABI 43" strings.

## `constants.ts` — my pre-/post-kernel framing was wrong, and the correction is the finding

The brief told the agent to split the file on "runs before a kernel exists"
versus "runs when a kernel is up", and to prove the line with call sites. It
did, and **found a third category the framing lacked — the largest one: no
kernel is reachable at all.**

- **Post-kernel (proven):** `exec-target.ts:461` calls
  `kernel.execTargetShebang` on the same token fifteen lines above;
  `node-kernel-worker-entry.ts:1017` passes `getKernelAbiVersion()` *as the
  argument*; `:1478` sits between `createProcess()` and `registerProcess()`.
- **Pre-kernel (genuine floor):** `kernel.ts:1588` `detectPtrWidth` inside
  `#compileKernelModule` — needed to build the import object *before* compile.
- **No kernel reachable:** `worker-main.ts:3219`, `dylink.ts:{1199,1306,1320}`,
  `fork-host-import-runtime.ts:447`, `wasm-module-reflection.ts` all run in the
  **process worker**, which has no kernel instance at all;
  `binary-resolver.ts:2888` runs on the main thread validating `kernel.wasm`
  before any kernel exists.

**Consequence: a kernel export cannot delete this file.**
`describeWasmArtifactPolicyFailures` transitively needs ~2,900 of the 3,031
lines, and a single pre-kernel caller keeps that whole graph alive. The
destination has to be a **standalone zero-import Rust module** — the shape K5's
`crates/dylink` already proved — which dissolves the bootstrap paradox instead
of working around it.

### What landed

`crates/wasm-artifact` (2,258 lines, `no_std + alloc`): the container walk on
`wasmparser`, and **no second decoder for any descriptor** — linked-frames,
module-state, exception-codec, imported-globals, imported-tables and static-root
all route to the `fork-codec` module that owns them.

**The duplication was three-way, not two:** `tools/xtask/src/build_deps.rs:14661`
is a third implementation. The census had found two.

`kernel_exec_target_artifact_policy` now judges the exec target in the kernel,
at **zero extra cost**: `PreparedExecTarget::new` already reserves the whole
artifact and the host fills it *through* the kernel — the old path read those
bytes back out and re-parsed them in JavaScript.

**Two real defects fixed rather than faithfully ported:** `readULEB128`
accumulated with a 32-bit `|=`, so a section length ≥ 2³¹ read negative; and
byte reads ran past the buffer end.

### The finding worth acting on separately

**`handleSpawn` has no *kernel-side* artifact-policy check on either host.**
`worker-main.ts:3219` is the only place that verifies the ABI-contract digest.

**Verified by the coordinator, and the wording matters:** `centralizedWorkerMain`
is the process-worker entry on **both** hosts (`worker-entry.ts:43`,
`worker-entry-browser.ts:34`), so every spawned process boots through it and the
artifact **is** validated before execution on every spawn path. **This is not an
unchecked path.** It is a check living host-side, in the process worker, rather
than in the kernel that should own the policy.

That makes it a **migration target aligned with the campaign's goal**, not a
security hole — and the distinction is worth keeping, because "no kernel-side
check" and "no check" are one word apart and describe very different
situations. The exec path has now moved
(`kernel_exec_target_artifact_policy`); spawn has not.

### NDD-CONST-1 — largely dissolved by K5 I6a

The agent filed this because a second module pipeline would mean 14 integration
points, and K5 was mid-flight on exactly that machinery. **That is no longer the
cost.** K10 built `CORESIDENT_SIDE_MODULES`, K5 I6a adopted it after arguing it
was the better design, and adding a module is now **one table row plus the four
browser registration points** — which is precisely the reuse the table exists
for.

**Coordinator's read: fold `crates/wasm-artifact` in as a fourth row after
I6b lands.** It is no longer a 14-point decision, so it does not need to be the
maintainer's. Flagging rather than deciding only the part that is theirs: the
`handleSpawn` gap above.

## NDD-K5-1 — I6b is a second increment, and my brief said otherwise

I dispatched K5 I6b as "a rewire, not infrastructure work". **That was wrong,
and the agent proved it against call sites rather than accepting the framing.**

`crates/dylink-module`'s 21 exports cover the **load path only**. Six of the
thirteen `DynamicLinker` methods `worker-main.ts` calls have **no host↔module
contract at all**:

1. **`DT_NEEDED` resolution** — no `HostRequest`, no NEEDED-list export, so a
   driver would have to parse `dylink.0` in TypeScript.
2. **`dlsym`→address** — `dl_sym` returns `(instance, export)`;
   `LinkerScope::function_table_index`/`record_function_slot` (the D5
   replacement for the TS identity scan) are not exported.
3. **Multi-transaction sessions** — `dl_open_begin` refuses a second load, while
   `worker-main` keeps a `Map`.
4. **`dl_fork_state`** — absent, and `forkArchive.sync(linker.forkState())` runs
   after every staged step.
5. **`reconcileForkModules`/`reconcileForkHandleState`** — pthread-peer
   reconciliation, no Rust counterpart.
6. **`dlclose` unload details.**

**That is a second increment the size of I6a.** The 6,340 lines stay owed.

**What did land is exercised, not dormant**, which is why this is a scoping
error rather than a failed item: the KFLA archive writer re-encodes the
committed TypeScript-written fixture **byte for byte at its own record
addresses**, and the surviving TypeScript floor was proven by driving a real
`wasm32posix-cc -shared` `.so` to a live instance — `adder_add(20,15)`→42, data
segment mutated →43, `dl_sym` hit and miss, `dl_close` released — with a second
`.so` carrying a strong undefined symbol **failing the load** on ELF semantics.
Two gap tests pin items (1) and (3) so that closing them makes the tests fail.

**dlopen suite: 115 passed / 2 failed / 1 skipped of 118 — exactly the
baseline**, both failures naming the tracked `__wpk_fork_frame_reserve` gap.

**Process hazard the agent flagged:** `TaskStop` on a `scripts/dev-shell.sh`
task killed a *concurrent* `dev-shell.sh` build in the same worktree
(`Terminated: 15`, exit 143). Agents sharing a worktree must not stop dev-shell
tasks.

## Baseline before the merge wave, measured 2026-09-10

Taken deliberately, before eight agents land, so any breakage afterwards is
attributable to whoever caused it rather than to whoever merged first.

- **`cargo test --workspace`: 3,668 passed, 0 failed.**
- **`tsc -p host/tsconfig.typecheck.json`: 9 errors** — 8 in
  `packages/registry/openssl/src/tls/` and 1 in
  `host/src/networking/tls-network-backend.ts`, all the same
  `SharedArrayBuffer`-versus-`BufferSource` family (B15/B16). **Zero elsewhere
  in `host/src`.**
- Host imports **76**, kernel exports **~201**, in-scope TypeScript **−884**.

**The run found one failure and it was the coordinator's** — the asyncify gate's
own test. Its fixture was a wasm header followed by the loose text
`exported asyncify_start_unwind`, with no export section at all, so it had
never tested the property it claimed to test; only that the bytes contained a
string. It stopped passing the moment the gate began reading export names
instead of substring-scanning.

That is the same defect one level down: **the gate could not tell a property
from a mention, and neither could its test.** A fixture built to satisfy the
scan rather than the property is how the gap survived to reject the kernel.

Had the baseline not been taken, that failure would have surfaced inside
someone else's merge and been attributed to them.

## OWED-WORK REGISTER — every outstanding item, audited 2026-09-10

Written after an audit found **six items that existed only in agent briefs and
a chat transcript**, not in any document. That is the failure this register
exists to prevent: work that is dispatched is not thereby recorded, and a
session that ends takes its briefs with it.

**Rule: nothing is dispatched until it appears here.**

### A. In flight — an agent is working it right now

| # | Item | Deletes / changes | Owner |
|---|---|---|---|
| A1 | K5 I6c — six missing `DynamicLinker` host↔module contracts | `dylink.ts` 4,188 + `dylink-fork-archive.ts` 2,152 | agent |
| A2 | `crates/wasm-artifact` side module + cutover | `constants.ts` remainder ~2,900 | agent |
| A3 | K4b — remaining worker-entry declarations (21, not 16) | ~2,700 | agent |
| A4 | pthread slot arena unification + dead surface | `shell-config.ts` 91; `host_call_signal_handler` (76→75); one authority | agent |
| A5 | Reconciliation — `usePolling` + poller, 16 memory-authority sites, epoch strings | ~200 | agent |
| A6 | `hostname.ts` (99) MIGRATE · `device-fs.ts` (335) ELIMINATE · `boot-descriptor.ts` (507) scope-check | ~940 | agent |
| A7 | **B7** — epoll instances to OFD ownership; fork inheritance | unblocks A-future B6 (the host epoll mirror) | agent |
| A8 | **B17+B18+B19** — `tar/wasm32` compile, root npm install, stale-tier install | throughput, not lines | agent |

### How the next item is chosen

The original Tier 1/2/3 structure was built around the K-items and they are all
done or in flight. What follows is not tiered; it is ordered by this rule,
which comes from the maintainer's four goals plus the one lesson this campaign
paid for — **deletion is what counts, not migration.**

1. **Unblockers.** B7 gates B6. B3 is gated on a benchmark that does not exist.
   Nothing downstream moves until these do.
2. **Force multipliers.** B17, B18, B19 serve none of the four goals directly
   and have each cost hours of agent time, repeatedly. Every one produces a
   failure that names something other than its cause. **Highest value per line
   changed on this list.**
3. **Deletes TypeScript *and* shrinks the host surface** — B1 (completes V3), B9.
4. **Deletes TypeScript** — B5, B2, B12.
5. **Correctness found along the way** — B15, B16, B11.

**Parallelism is bounded by two things, neither of which is agent count:**
shared foundation files (`local_build.rs`, `rootfs.rs`, `wasm_api.rs`,
`kernel-worker.ts` — where *both* design collisions landed, not in the leaf
files agents were assigned), and the coordinator's serial merge throughput.
Batch by file locality, and do not start two items that restructure one
foundation file.

### B. Owed, no agent — each needs dispatching or an explicit decision

| # | Item | Why it is still here |
|---|---|---|
| B1 | **K1 step 5** — the JSON `entries[]` path and the image ABI stamp | **Completes V3.** Recorded only as a table cell until now; never scoped. Removes ~2,000 lines across `memory-fs.ts`/`sharedfs-vendor.ts` once the stamp goes. |
| B2 | **K7 re-cut piece 2** — the shared-mapping coherence layer | ~1,203 TS lines have no Rust counterpart; sized as policy, not plumbing |
| B3 | **K7 re-cut piece 3** — anon + file mapping cutover | Gated on a **targeted** shared-mapping benchmark; a general syscall benchmark exercises only the early-out |
| B4 | **The measured 3.7× SysV regression** | Zero-import remedy identified: hoist destination validation *before* the source view, rather than deleting `host_proc_read_bytes`'s second copy — that copy narrows a grow-detach window |
| B5 | **K11 device pieces 2, 3, 4** | Framebuffer input encoding, WebGL command decode, TLS message framing — ~2,300 lines, blocked at the time on file ownership that has since cleared |
| B6 | **K3 epoll cutover (K3-7.7)** | Deletes the epoll mirror; gated on B7 |
| B7 | *(moved to A7 — dispatched)* | |
| B8 | **K3 wait-queue cutover** | `wait_queue.rs` + `wait_shadow.rs` are dormant; the shadow has never seen live traffic |
| B9 | **NDD-IOVEC-1 — per-process pointer width at registration** | **Maintainer approved.** Frees `preadv2`/`pwritev2`'s `flags` slot, currently holding the width stamp. Must survive fork inheritance and a width-changing exec. Do it *before* anything else claims slot 5. |
| B10 | **NDD-K4-1 — kernel-owned shebang parsing** | The duplicate is shared (one call site); the kernel move needs a prepared-target token the side-effect-free spawn preflight cannot obtain |
| B11 | **`report_writeback_loss` wiring** | Kept, and the reason imports read 76 not 75. Better home: kernel-visible state readable through an existing export — costs no import, survives the session, and is testable |
| B12 | **`privileged-projection.ts` (864) — test-only** | Census finding, unrecorded until now. Open as D-K8-4 |
| B13 | **`dylink-planner.ts` (796) test-only** | Becomes production when A1 lands; **`dylink-planner-wire.ts` is NOT test-only** — Serena refuted that; it is imported by production source |
| B14 | **SysV IPC conformance coverage** | None exists anywhere in `tests/`. Deferred by the maintainer; new tests, not adopted ones |
| B15 | **TLS `SharedArrayBuffer` hazard** | All three engines throw on SAB-backed views; reachability unproven. Fix when the file is next touched: copy at the boundary, tighten `ArrayBufferLike` → `ArrayBuffer` |
| B16 | **8 openssl + 1 host typecheck errors** | The `host/src` one is in `tls-network-backend.ts`, K11's file — same SAB family as B15 |
| B17 | **CLOSED — and it was never a `tar` or overlay defect** | See "B17/B18/B19 closed" below. `tar/wasm32` builds green on this base; the error was a broken sysroot wearing a package's clothes |
| B18 | **CLOSED** | `xtask bootstrap` gained a `root-npm` step |
| B19 | **CLOSED** | The install now fails loudly rather than leaving the tier consumers read stale |
| B17 | *(moved to A8 — dispatched)* | |
| B18 | *(moved to A8 — dispatched)* | |
| B19 | *(moved to A8 — dispatched)* | |
| B20 | **Tier-end browser pass** | Now split: **needs the app booted** — K8's MITM CA-write ordering, K4's D17 interrupt timer and D2 exit-dedup, browser lifecycle paths. **Needed only an engine** — three items already closed this way |

### B17/B18/B19 closed — three build-environment defects, one shape

Each produced a failure that named something other than its cause.

**B17 was not a `tar` bug, an overlay bug, or an include-order bug.** On
`3011a5854` with a freshly built musl sysroot, `tar/wasm32` builds green
through both `build-deps --force-source-build resolve tar` and the SourceOnlyV1
engine (`xtask bootstrap tar`); `config.h` reports `HAVE_READDIR 1` and no
`gnu/readdir.o` is produced at all. The reported error is reachable only by
compiling `gnu/readdir.c`, which is gnulib's *replacement* `readdir` -- gnulib
compiles it only when its configure probe concluded the C library has no
`readdir`, and it dereferences `dirp->real_dirp`, a member of gnulib's own
`DIR` (`dirent-private.h`, under `GNULIB_defined_DIR`). Compiling that file
directly reproduces the reported text exactly:

```
gnu/readdir.c:38:23: error: incomplete definition of type 'DIR'
                            (aka 'struct __dirstream')
```

`DIR` is the POSIX-correct opaque `struct __dirstream`, declared identically by
upstream musl and by `libc/musl-overlay/include/dirent.h`. **The owning layer
is the sysroot build step**, and the cause is the silent-success
`scripts/build-musl.sh` recorded as validation trap 3: it exited 0 leaving a
partial tree and no sysroot, so a configure probe could not link and concluded
`readdir` was missing. That was fixed in `e93167651`, which is on this base and
was *not* on `1b9d806e1`, the commit B17 was reproduced against. What remained
was the postcondition half: the script's tail was
`ls -la "$SYSROOT/lib/libc.a" || echo "WARNING: libc.a not found!"`, which
warned and exited 0. It now fails.

**B18: `xtask bootstrap` gained a `root-npm` step**, first in
`bootstrap_step_plan()` and also a prerequisite of single-target selections.
The sealed exclusion was checked and is narrower than it looked:
`build-rootfs.sh` refuses to install under `ROOTFS_SEALED_BUILD=1` because
*resolver-owned package builds* must be read-only with respect to the checkout.
`bootstrap` is the step whose job is to provision the checkout, so both guards
stay as they are. It runs CI's exact command
(`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund`), keys on the
same `node_modules/tsx/dist/cli.mjs` the build scripts guard on, and re-checks
afterwards so an `npm ci` that exits 0 without producing it still fails.

**B19 took the truthful-failure option, not the kinder one.** After a
successful publication, `install-local-artifact` compares what it installed
against the same relative path in `local-binaries/source-only-v1` and fails if
they differ. Making one command leave every tier consistent was rejected for a
reason, not for size: the SourceOnlyV1 root is a content-addressed projection
whose manifest records each member's size and sha, and the browser resolver
validates fetched bytes against it. Copying bytes in from the installer would
leave the manifest describing the old member -- a silent inconsistent tier in
place of a loud stale one. The check is skipped when `WASM_POSIX_DEP_OUT_DIR`
is set, because that is the resolver-build window in which the two tiers are
*expected* to disagree.

**`verify-fresh` was right the whole time** and this adds no new source of
truth; it makes the command that *creates* the inconsistency report it at the
moment it creates it.

### Two findings from this work, neither in scope

- **`cargo test -p xtask` has one pre-existing red test on base.**
  `program_output_validation_rejects_legacy_asyncify_wasm` fails with
  `parse wasm: unexpected end-of-file (at offset 0xa)`. Confirmed pre-existing
  by running it against `3011a5854`'s own `build_deps.rs`. It is a fixture
  artifact of `e93167651`: that commit correctly changed
  `wasmContainsLegacyAsyncify` from a byte scan to an export-name test, and the
  fixture is a truncated file carrying the ASCII string, which the new check
  cannot parse. **Baseline is 606 passed / 1 failed, not 605 passed.** With the
  two tests added here: **608 passed / 1 failed**.
- **The machine ran out of disk mid-run.** One full `cargo test -p xtask`
  reported 16 failures, 15 of them `Os { code: 28, kind: StorageFull }`; `df`
  showed 1.1 GiB free of 1.8 TiB. Discarded and re-run after space freed.
  Worth knowing while six worktrees share one disk: a contaminated run of this
  suite looks like a scatter of unrelated `build_deps` failures.

### C. Closed by measurement, kept only so they are not re-opened

`host_futex_wait` · `host_sigsuspend_wait` · `host_debug_log` declared-vs-linked ·
the E1 GC blockers · the V8 `epoll_pwait` crash · the four-JS-act dylink floor ·
the K1b callerless `assertImageKernelAbi` · `netif.rs`'s "cannot itself reach" ·
OPFS-as-live-floor · the `constants.ts` "re-export shim" KEEP · the
pre-/post-kernel two-category framing · "16 inseparable pairs" · "~30 ABI-43
strings" · the `describeWasmArtifactPolicyFailures` holder · wasmtime-exnref.

**Fifteen disproved claims. Seven were written by the coordinator.**

## Open decisions collected — the ones needing the maintainer, in one place

1. **The 76th host import.** `host_debug_log` is now live and linked, because
   K7 supplied a caller (`report_writeback_loss`) for a declaration K9 had
   removed as callerless. One import whose only job is to make an unrecoverable
   shared-mapping writeback loss *visible* rather than silent. Keep it, or
   surface the loss without a host call?
2. **NDD-K4-2 — the last 16 worker-entry pairs.** One fork/exec/clone/init
   family, ~2,700 lines. **Cannot be split**: each constructs or tears down a
   process generation, so all need the same ~3 new host hooks. Three together
   buy the hooks once; one alone saves almost nothing. Recommendation: one item,
   fork-path guest suites provisioned first.
3. **NDD-K4-1 — `parseShebang`'s kernel move.** The duplicate is now shared
   (one call site, not two), so the remaining question is only whether the
   *kernel* should own shebang parsing. `kernel_exec_target_shebang` needs a
   prepared target token the side-effect-free spawn preflight cannot obtain
   without breaking POSIX's "file_actions exactly once".
4. **K7 re-cut pieces 2 and 3** — the coherence layer (sized as policy, not
   plumbing) and the anon+file cutover, the latter gated on a *targeted*
   shared-mapping benchmark. A general syscall benchmark exercises only the
   early-out and cannot close the question.
5. **The measured SysV regression.** 3.7× on a clean boundary with a live peer.
   Cheaper remedy first: `host_proc_read_bytes` copies its range **twice** and
   allocates per call — host-side, no import. Beyond that, the campaign's one
   sanctioned import `host_proc_compare_bytes` is now **evidence-backed rather
   than argued**. Neither has been spent.
6. **K6's ABI motion.** The snapshot moved twice without a bump: five exports
   removed, and `kernel_sendmsg`/`kernel_recvmsg` changed **arity**. Consistent
   with the one-epoch ruling, but arity changed, not just counts.
7. **K3's remainder** — `usePolling` deletion, and two epoll POSIX gaps
   (interest-list inheritance across `fork`, OFD keying). Ruling was "fix if
   straightforward, else log explicitly and defer"; not yet actioned.
8. **Should `./run.sh setup` install root npm dependencies?** It already
   bootstraps `host/` and `tools/mkrootfs/` on the non-sealed path. This is the
   one provisioning step a fresh worktree needs that `setup` does not perform,
   and its absence cascade-blocks every browser product.
9. **No SysV conformance coverage exists anywhere in `tests/`** — checked, not
   assumed. A platform gap worth its own item.

## Open decisions for the maintainer

0. **Free channel slot 5, or accept that `preadv2`/`pwritev2` can never carry
   `RWF_*`.** The caller's pointer width is stamped into the private sixth
   channel argument, which for those two Linux extensions is the guest's
   `flags`. Nothing observable regressed — no `RWF_*` flag is implemented and
   `RWF_NOWAIT` is still honoured from the host's pre-overwrite view — but the
   slot is now spoken for. The alternative is giving the kernel a per-process
   pointer width at process registration and dropping the per-dispatch stamp
   entirely, which would free the slot for every kernel-dereferenced syscall
   and is a V2/V4 win in its own right; it also has to survive `fork`
   inheritance and an `exec` that changes the guest's data model. Cost now:
   a process-table field, one registration path, and a fork/exec review. Cost
   later: the same work, plus whatever has been built on slot 5 by then.
   Recommendation: do it as its own item before anything else claims slot 5.
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
- **Guest tests resolve `local-binaries/source-only-v1/kernel.wasm` BEFORE the
  ambient `local-binaries/kernel.wasm`.** `install-local-artifact` refreshes
  only the latter, so a stale source-only tier wins silently.
  `scripts/xtask.sh verify-fresh` names it exactly; believe it.
  `./run.sh rebuild kernel` is the fix. Tenth silent success.
- **`npx tsc` without `node_modules` prints a friendly message and exits 0.**
  Use `host/node_modules/.bin/tsc`. Ninth silent success.
- **Every `#[test]` in `crates/kernel/src/wasm_api.rs` runs on no target.** The
  module is wasm-only and the kernel is never tested for a wasm target; twenty
  test functions are compiled by nothing. Eighth silent success.

## K5 I6b — the cutover contract, measured (2026-09-10)

I6b was scoped as "the KFLA encoder, the TypeScript driver/executor, the
`worker-main.ts` rewire, and the deletion". Two of those four are now done and
**exercised**, not dormant. The rewire is not, and the reason is a gap the scope
did not name: **`crates/dylink-module`'s 21 exports cover the LOAD path and the
simple query path, and nothing else.** Six of the thirteen `DynamicLinker`
methods `worker-main.ts` calls have no host↔module contract at all.

This is the I6a lesson again, one level up. **Silence in a work contract reads
as completeness**: the brief enumerated what was left to WRITE and was silent
about what the module could not yet be ASKED, so the item looked like a rewire
and is a second increment of comparable size to I6a.

### Landed and exercised

| what | evidence |
|---|---|
| KFLA archive **writer** (`fork_codec::dylink_archive::encode`) | re-encodes the committed TypeScript-written fixture **byte for byte** at its own record addresses, 6/6 |
| TS wire codec + eight-act executor (`host/src/dylink-planner*.ts`) | drives a real `wasm32posix-cc -shared` `.so` to a live instance, calls into it, mutates its data segment, `dl_sym`s it, `dl_close`s it — 6/6 |

The byte-for-byte fixture match also settled two open questions: the KFLM/KFLT
template digest is plain SHA-256 over the module bytes, and the KFLT header's
72..80 tail is reserved zero.

Two findings the drive test produced rather than assumed: an SDK-built side
module imports **shared** memory with a declared maximum (a non-shared test
memory fails instantiation with a shared-state mismatch), and an object whose
only static is never written is constant-folded and needs no `__memory_base` at
all — the first version of that test passed while proving less than it looked
like it did.

### The six missing contracts, each verified against a call site

1. **Dependency resolution.** `loadSharedLibrary` resolves `DT_NEEDED`
   recursively through `resolveLibrarySync` (`dylink.ts:2486-2491`).
   `LinkPlan::begin` requires every dependency already in scope, there is no
   `HostRequest::ResolveDependency`, and no entry point reports an image's
   NEEDED list. A driver would have to parse `dylink.0` in TypeScript — linker
   policy in TypeScript, which is the thing this item exists to remove.
2. **`dlsym` address materialization.** `__wasm_dlsym` must return a guest
   scalar. `dylink.ts:4037-4067` scans the table for JS `Function` identity and
   appends a slot when absent; `dl_sym` returns a `ResolvedSymbol` naming
   `(instance, export)`. The Rust replacement for that scan already exists —
   `LinkerScope::function_table_index` / `record_function_slot`, the D5 design —
   but is not exported, so the driver cannot answer without either a new entry
   point that drives `GrowTable`/`WriteTable`, or re-implementing the scan in
   TypeScript.
3. **Multi-transaction sessions.** `worker-main.ts` keeps a `Map` of pending
   tokens (`ownedDlopenTransactions`) and `dylink.ts` a `pendingDlopens` map;
   `dl_open_begin` refuses a second concurrent load outright, and its own docs
   say so. A constructor that calls `dlopen` is legal POSIX, and
   `LoadState::Initializing` exists precisely for it.
4. **Fork-state capture.** `forkArchive.sync(linker.forkState())` runs after
   every staged step, every commit and every `dlclose`. There is no
   `dl_fork_state`, and `LoadedLibrary` gained `module_bytes` here as the first
   half of making one possible.
5. **Fork reconcile.** `reconcileForkModules` + `reconcileForkHandleState` are
   peer-publication reconciliation across pthread workers: incremental identity
   verification, visibility and provider-edge drift adoption, consumer-before-
   provider removal. No Rust counterpart.
6. **`dlclose` unload details.** Releasing an object must clear its owned table
   slots and release its allocations; `owned_table_entries` and `allocations`
   live on `LoadedLibrary` and are not reachable from the module surface.

Two smaller ones in the same family: `recordConstructorProvider` records a
provider edge from a constructor-time `dlsym` onto whichever object is in its
`constructors` stage, which crosses `dl_sym` and the in-flight plan; and
`dl_open_finish` has no way to report the layout the archive must record for a
library that finished, only for one still in flight.

### NEEDS-DEFER-DECISION — NDD-K5-1

**What:** the `worker-main.ts` rewire and the deletion of `host/src/dylink.ts`
(4,188) and `host/src/dylink-fork-archive.ts` (2,152).

**Why not now:** the six contracts above. Each is a decision that must live in
`crates/dylink` under the item's own generic-first rule; implementing any of
them in the TypeScript driver would pass the deletion while re-creating the
linker in the file that replaced it.

**Cost now:** an increment roughly the size of I6a — six entry points, their
wire records, the multi-transaction session change, and a fork-state capture
that has to agree with the archive writer that now exists.

**Cost later:** none that grows. The two pieces landed here are the halves that
had no callers and are now proven; nothing about them decays. The 6,340 lines
stay owed.

**Recommendation:** run I6c as "the six contracts + the rewire", with the list
above as its scope rather than a line count. The KFLA writer means the archive
half is no longer the harder one: a driver that can capture fork state in Rust
gets `dylink-fork-archive.ts` for a few hundred lines of allocate-and-copy,
which is why 4 and 5 should land together with the rewire rather than after it.

### K5 I6a's browser registrations — three of four closed, measured (2026-09-10)

Run against a real SourceOnly Vite dev server in this worktree, with the
planner module rebuilt from the current tree and the projection re-finalized
(`verify-fresh` exit 0).

| registration | state | evidence |
|---|---|---|
| capability contract (`browser-module-contract.mjs`) | closed by I6a | it supplies the alias name that resolved below |
| **Vite alias `@dylink-module32-wasm`** | **CLOSED** | resolves to `local-binaries/source-only-v1/dylink_module32.wasm`, the SourceOnly projection path |
| **`?url` artifact module** | **CLOSED** | `browser-dylink-module-artifact.ts` transforms 200 and exports the URL |
| fetch/transfer/compile chain | **fetch closed, transfer NOT** | see below |

The **fetch** half is closed at the dev server: `HTTP 200`,
`content-type: application/wasm`, 233,525 bytes, `cmp`-identical to the staged
artifact — and those exact served bytes compile to **0 imports and 21 `dl_*`
exports** and instantiate. The **transfer** half (the `dylinkModuleBytes`
protocol field crossing `postMessage` into `browser-kernel-worker-entry.ts`,
and the `WebAssembly.compile` there) is still unproven, because the app never
boots in this worktree.

**Why it does not boot, and why that is not this item's:** `run.sh
prepare-browser` exited 1 with **`php/wasm32`** (the documented ICU
`pkg-config` failure) and **`wget/wasm32`** (`curl: (35) TLS connect error`
fetching upstream source — a network failure, not a platform one). Those
blocked 12 downstream nodes, `coreutils-docs` among them, and the artifact
resolver then refuses the whole closure rather than mixing provenance tiers:
`Package artifact closure is incomplete: no single provenance tier contains
every accepted artifact`. The page 500s on `lazy-archives.ts` long before any
kernel worker starts.

Two things worth keeping from the attempt: the dev server's COOP/COEP headers
are right (`crossOriginIsolated=true`, `SharedArrayBuffer` available), and the
failure is a *provisioning* message rather than a behavioural one — the same
tell the campaign's contaminated-run note describes, here reported honestly
instead of read as a broken feature.
- **Fourteen inherited claims have now been disproved, eight of them the
  coordinator's.** The newest is this census's own row 2 — see value plan §2y.
  Measure rather than inherit, *including* what was measured yesterday.

## K5 I6c — the TypeScript `ld.so` is deleted (2026-09-10)

`host/src/dylink.ts` (4,188) and `host/src/dylink-fork-archive.ts` (2,152)
are gone. Every `dlopen`, `dlsym`, `dlclose` and fork replay in a Kandelo
process is planned by `crates/dylink` and performed by a driver that makes no
linker decision.

**In-scope TypeScript for this item: −4,229**, measured
`5ba896788..f95a404ca` (Rust +5,191, of which +1,823 is test). The campaign
figure moves from −693 to roughly −4,922.

### The six contracts, and how each is exercised

| contract | closed by | exercised by |
|---|---|---|
| `DT_NEEDED` resolution | `HostRequest::ReadDependency` + the session's search order | a real `libtop.so`→`libleaf.so` chain built with `wasm32posix-cc -shared`, driven through the wasm module, asserting the exact probed path list; and a real `DT_NEEDED` closure resolved from the process VFS and replayed into a fork child (`fork-from-dlopen-side-module-e2e`) |
| `dlsym` → address | `dl_sym_begin`/`dl_sym_address` as a transaction | `dlopen-e2e` resolves `adder_add` to a table index and calls it; the second lookup performs NO engine work |
| multi-transaction sessions | tokens, `dl_pending`, `dl_finished` | two concurrent `dl_open_begin`s each get a token; the staged prepare/next/commit path runs a real side module |
| fork-state capture | `Session::fork_state` | four archive round-trips, including one taken at `wpk_fork_module_bootstrap` |
| fork reconcile | `fork_reconcile_begin`/`_finish` | a child rebuilds a parent's closure at the parent's addresses with the parent's handles |
| `dlclose` unload | `dl_close_begin`/`dl_close_result` | slots nulled, mapping released, global scope rebuilt; a dependency outlives its consumer only until the consumer is gone |

### Eight MORE contracts the six did not name

The previous agent's finding was right in kind and short in count. Closing
the six exposed eight more, each verified against a call site:

7. **The archive's record chain could not be read by the module at all.** It
   imports nothing, so guest memory is unreachable from inside it.
   `fork_codec::dylink_archive::walk::ArchiveWalk` turns the archive into a
   sequence of byte-range requests, and an `ArchiveBytes` trait lets ONE
   decoder serve both a flat caller and a sparse one.
8. **Funcref table-patch publication is not loader state** but rides in the
   same record chain under the same generation fence
   (`worker-main.ts:3041-3229`). It crosses back as the only part of the
   archive a driver reads.
9. **The parent's saved `GOT.func` value** (`dylink.ts:1651`). A child
   re-deriving a funcref index aims a live function pointer at a different
   function. The planner decided GOT cells in a phase that ran BEFORE the
   activation existed, so `Activation` now runs before `Got` and the planner
   ASKS (`HostRequest::SavedGotFunc`).
10. **The process's own exception tags.** The planner would have created its
    own; a side module given a tag the main image cannot catch in fails only
    when an exception crosses. `dl_adopt_process_tags`.
11. **A staged transaction must be claimed by a module initialization**, and
    a load suspended at bootstrap has no committed record to claim it. The
    session synthesizes the provisional record from the in-flight plan.
12. **An in-flight staged transaction must be RESTORED in a fork child** —
    `dylink.ts:2854 restorePendingDlopenTransactions`. Done: the child
    rebuilds the interrupted object under the PARENT's token, stopping at
    the call the parent was suspended in and acknowledging every earlier
    staged call WITHOUT invoking it.
13. **A process that links nothing still publishes the archive.** Funcref
    table patches are captured from a live `WebAssembly.Table` before they
    are published, so a capture carries no generation — the fence value
    belongs to the publication, and the format requires patch generations
    strictly increasing and no greater than the header's. Left at zero, the
    whole publication was unencodable, and a process with no
    `__indirect_function_table` was additionally refused for having no main
    image. Both are fixed; the session numbers each unassigned patch.
14. **Linear memory is observed, not configured.** The bound an allocation is
    checked against changes under the loader: guest code grows memory between
    loads, and the process allocator grows it to satisfy the very mapping
    being checked. The driver now reports what memory measures after every
    step it performs, immediately before the answer reaches the planner —
    an observation, not a decision. Without it the legacy two-argument
    loader's late load was refused as "allocation escapes linear memory".

### One defect that was blocking the whole branch

`wasmContainsLegacyAsyncify` scanned an artifact's entire byte image for the
ASCII text `asyncify_`. `crates/kernel` links `crates/wasm-artifact`, whose
own diagnostic string contains it — so the host resolver refused the kernel
that the kernel's own policy authority would have admitted, with "Binary
exists but was rejected by artifact policy". **Every real-`dlopen` e2e test
on this branch was gated behind that refusal**, which is why the recorded
`115 passed / 2 failed of 118` baseline could not be reproduced. Fixed by
applying the rule `crates/wasm-artifact` already applies — an artifact is
Asyncify-instrumented when it EXPORTS `asyncify_*` — which also retires the
duplicated authority.

### NDD-K5-2 — closed

The deferral raised against the ABI-43 legacy two-argument `env.__wasm_dlopen`
is withdrawn: the path is green.

The `(null)` `dlerror()` was a red herring — the SDK-lowered stub is not
libc's `dlopen`, so it never populates `dl_error_buf`, and the guest-visible
diagnostic could not say what failed. The real failure was contract 14 above:
`dl_resume: dlopen:<ptr>:<len>: allocation escapes linear memory`. This path
loads its side module late, from bytes the program itself read into a heap
that had already grown, so it was the first caller to sit past the memory
size the loader had captured at construction.

Contract 12 (restoring an in-flight staged transaction in a fork child) is
also done: `fork_reconcile_begin` rebuilds the interrupted object under the
PARENT's token with `resume_at` naming the call to stop at, and every earlier
staged call is acknowledged without being invoked — the rule
`advanceWithoutGuestCalls` (`dylink.ts:2981-3013`) encodes.

There is no NEEDS-DEFER-DECISION open against this item.

### What was measured

The `dlopen` suite, in the dev shell against a freshness-verified kernel and
a rebuilt planner module: **34 passed / 2 failed / 1 skipped of 37.** Both
failures are the tracked pre-existing pthread `__wpk_fork_frame_reserve` gap
(73fd6763f) — "replays pthread-hosted dlopen table state into a fresh fork
child" and "blocks a foreign pthread until the staged loader owner commits".

**On the recorded `118 executed` baseline.** That count included
`host/test/dylink.test.ts` (77 cases) and `host/test/dylink-fork-archive.test.ts`
(12), which tested the deleted implementations and went with them. The
suite's composition changed; quoting 37 against 118 without saying so would
be comparing two different things.

`cargo test -p dylink -p dylink-module -p fork-codec -p runtime-core
--target aarch64-apple-darwin`: **2,503 passed, 0 failed.**
`cargo check` clean on wasm32 and on wasm64 (`-Z build-std=core,alloc`).
`scripts/xtask.sh verify-fresh`: clean, including the co-resident
`dylink-module` projection gate.

**What could not be run, and why.** `./run.sh setup` fails at `php/wasm32`
(configure cannot find ICU through `pkg-config`), which blocks the four
products downstream of it and, with them, the aggregate projection
finalizer. That failure predates this item and is unrelated to it; the
projection was re-finalized through `xtask bootstrap browser-main-shell`,
which the engine merges into the aggregate rather than truncating it. The
browser demo's fourth-registration check needs an app boot that fails on
php (ICU) and wget (TLS) for the same reason.

**Coverage this traded.** `host/test/dylink.test.ts` (3,265) and
`host/test/dylink-fork-archive.test.ts` (492) tested the deleted
implementations and went with them. Standing in their place: 128 Rust tests
across `dylink`/`dylink-module`, 460 in `fork-codec` including the
byte-for-byte encoder check against the archive image the TypeScript writer
actually produced, and the real-`dlopen` e2e suite, which is unchanged and
remains the behavioural gate. `crates/fork-codec/testdata/dylink-archive-wasm32.bin`
is now FROZEN and its generator deleted: regenerating it from the surviving
writer would turn the reference into a self-portrait.
