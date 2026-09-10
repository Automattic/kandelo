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
5. a kernel build installed via `build-deps … install-local-artifact`
   (`./run.sh rebuild kernel` alone does **not** repoint the ambient artifact)
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
- **Fourteen inherited claims have now been disproved, eight of them the
  coordinator's.** The newest is this census's own row 2 — see value plan §2y.
  Measure rather than inherit, *including* what was measured yesterday.
