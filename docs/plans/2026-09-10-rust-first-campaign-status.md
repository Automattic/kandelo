# Rust-first campaign — live status

**Purpose:** one file that answers "where are we" after a crash or context loss.
Update it as work lands. The reasoning lives in
`docs/plans/2026-09-09-rust-first-value-plan.md`; this is the index.

**Branch:** local `brandonpayton/rust-first-abi44-reconcile` → remote
`brandonpayton/epoll-kernel-route` (PR #1350). **Push forward-only. Never
amend, never force-push. The maintainer is the sole merger.**

**Last pushed:** `b5db3ca38` (2026-09-10)

## THE LEDGER, MEASURED PROPERLY (2026-09-10) — and what it exposes

Measured against the campaign merge-base `9195dedd1`, with rename detection
on. Earlier figures in this document quoted a *session* delta or an unsplit
total and read far better than the truth.

**Production TypeScript — every `*.test.ts` / `*.spec.ts` and test directory
excluded — is net −2,460 for the whole campaign.**

| | files | lines |
|---|---|---|
| Deleted outright | 13 | **−12,254** |
| Modified | 51 | +9,889 / −15,208 → **−5,319** |
| Newly created | 38 | **+15,113** |
| | | **net −2,460** |

Including tests, the totals are 107 new files (+25,899), 37 deleted (−22,307),
125 modified (net −7,572) → **net −3,980**. Rust over the same range is
**+96,855**.

### Where the new production TypeScript went

| family | lines |
|---|---|
| fork-module host driver (15 files) | 4,957 |
| dylink host driver (5 files) | 3,666 |
| worker/process unification (`process-lifecycle.ts`, `worker-protocol.ts`) | 3,840 |
| side-module drivers (`wasi-module-instance`, `wasm-artifact-driver`) | 1,243 |
| other | ~1,400 |

**One of these is fine and the rest are the finding.** The 3,840 for the
worker/process unification is a *dedupe*: it collapsed two duplicated worker
entries into one, and the two files it replaced shrank by 4,741 lines. That
family is net negative and did exactly what the campaign intended.

**The other ~9,900 lines are host-side glue written to drive the Rust
modules,** and they are the campaign arguing against itself. The clearest
single case: the TypeScript `ld.so` (`dylink.ts`, 4,188 lines) was deleted and
a TypeScript dylink **driver** (3,666 lines across 5 files) was added.

That is not the trade this campaign was for. **V4 — minimize the host API
surface so a new host is cheap to write — is the maintainer's stated primary
goal, and every one of those ~9,900 lines is surface a wasmtime host must
reimplement.** Some of it is the declared irreducible floor: worker spawn, the
`fork()` syscall and syscall-channel transport, `resolve_externref` identity
materialization, anyref-transit `Table.grow` sizing, PIC placement globals, the
resume `WebAssembly.Table`, and the Node/browser platform bridges. But the
floor was scoped as a handful of capabilities, and this is three orders of
magnitude larger than that.

### What this changes about what to do next

The register has been ordering work by "deletes TypeScript". On this
measurement that ordering is incomplete: an item that deletes 2,000 lines and
adds 1,800 lines of driver glue scores well on the ledger and **loses** on V4.

**Proposed, needs the maintainer:** make the next major target the driver glue
itself — audit those ~9,900 lines against the declared floor, and for each
capability ask whether the host is *deciding* something (must move) or merely
*performing an engine operation only a host can perform* (genuine floor). The
`fork-module` and `dylink` driver families are where to start, being 8,623 of
the 9,900.

This is recorded rather than acted on because it changes the campaign's
priority order, which is the maintainer's call, not an agent's.

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
| K1 / K1b | **DONE** (steps 1-4); step 5 **BLOCKED** | Steps 1-4 landed. Step 5 was scoped on a premise measurement disproves — see the B1 row and the K1b grounding §7.5 |
| K10 | **DONE** | I1/I2/I3/I7 landed earlier; I4/I5/I6 landed 2026-09-10 — the Rust module runs and `wasi-shim.ts` is deleted. See §2x of the value plan |
| K10 | **COMPLETE** | I6 deleted `wasi-shim.ts` (−1,055); fixtures gate disproved; I4/I5 done |
| K14 | **DONE** | |
| K5 | **I6a DONE 2026-09-10; I6b owed** | Module built, projected, served on both hosts via the one side-module table; I6b = rewire + delete 6,340 lines |
| K8 | **incr 1 done; incr 2 REBASING** | Boot flip done in agent worktree; collided with K9 in `rootfs.rs` |
| K3 | **0a/0b/1/2 done; epoll cutover owed** | `wait_queue.rs` + `wait_shadow.rs` dormant |
| K7 | **piece 1 (SysV) CUT OVER; pieces 2/3 open** | SysV TypeScript deleted, TS −332. See "K7 cutover" below |
| K7 | **Rust landed; cutover MIS-SCOPED (confirmed twice)** | SysV re-cut RUNNING; see "K7 cutover" below |
| K12 | **DONE (scope corrected)** | GC elimination disproved; `fm_*` 72 → 70 |
| K11 | **CLOSED** | Piece 3 cut over; 2 and 4 immovable with structural reasons. See "B5 — K11 device pieces 2, 3 and 4" |
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
| B2 opening move | `getFdStatForSharedMapping` + `getFdAccessModeForSharedMapping` + the `host_fstat` capture side-channel | **PAID 2026-09-11: 207 removed, 113 added (net −94)** |
| K7 re-cut (2,3) = B2+B3 | rest of the mapping subsystem — **one atomic item, not two** | ~2,500 method lines recensused 2026-09-11 across 57 methods (was 2,630/64 before the opening move) |
| ~~K3-7.7~~ | ~~epoll mirror in `kernel-worker.ts`~~ | **PAID: 423 removed, 112 added (net -311)** |

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

### B3 re-scoped 2026-09-10 — the benchmark was never the binding gate

B3 was filed as blocked on a targeted shared-mapping benchmark, and the
maintainer ruled to proceed without one. That ruling removed one gate. A
second gate was already there, unrecorded on the B3 row, and an independent
census confirms it: **B3 cannot be performed while B2 is open.** The
maintainer's ruling does not unblock B3, because the benchmark was not what
was holding it.

**Censused, not inherited.** Every number below was measured on this branch
(`bb3d2111f`), not carried from an earlier report.

- The anon + file subsystem in `host/src/kernel-worker.ts` is **64 methods,
  2,630 lines** of method bodies, plus its type declarations and call sites.
- Of those, **~1,068 lines across 23 methods have no Rust counterpart** —
  independently reproducing the earlier ~1,203 figure to within the types and
  call sites that figure also counted. The gap is real and it is the B2
  coherence layer.

**The anon half is not separable the way the SysV half was, and this is the
part the "re-cut as three items" split got wrong.** SysV was separable because
it owned its own containers (`shmMappings` / `shmSegmentVersions`). Anonymous
and file mappings **share one container**, `sharedMappings`, and are
distinguished only by a `backingKind` field tested at **15 interleaved sites**
in the shared lifecycle paths — inherit, cleanup, remap, release, flush. An
anon-only cutover therefore cannot delete those paths; it would leave every
branch in TypeScript, add a kernel call inside each `anonymous` arm, and put
**two authorities over one address space**. Measured against the three
campaign numbers it deletes roughly 100 lines of TypeScript while adding more
than that in driver glue, and it ranks below doing nothing. Item 3's title,
"anon + file cutover", is accurate: the two are one item, and that item is
atomic with item 2.

### The K7 Rust is dead in production — the dead-floor pattern, mirrored

The ledger records K7's Rust as landed, and it is: it compiles, it is
unit-tested, and `docs` carry its parity table. **No production path reaches
the anon or file half of it.**

Verified by call-site census across `crates/`, not by reading the docs:

- **15 `SharedMappingTable` methods have zero callers outside `memory.rs`
  itself — 874 lines of method bodies.** `track_anonymous_mapping`,
  `sync_anonymous_from_process`, `get_or_create_file_backing`,
  `discard_unreferenced_file_backing`, `release_file_backing_reference`,
  `sync_file_from_process`, `publish_file_backing_observers`,
  `flush_fd_writeback_mapping`, `synchronize_for_boundary`, `flush_mappings`,
  `cleanup_mappings`, `remap_mapping`, `prepare_file_mappings_for_write`,
  `update_mapping_protection`, `release_all_for_process`.
- `inherit_process_mappings` (162 lines) **is** reached in production, through
  `inherit_sysv_attachments`, but only ever over an empty `mappings` map, so
  no line of its body has run outside a test.
- `FileBacking`'s page-cache methods add a further ~283 lines on the same
  footing.
- The nine `kernel_shared_mapping_*` exports are **all** `_sysv_`. There is no
  entry point into the other half at all.

That is roughly **1,300 lines of Rust with no live caller**, and it is the
campaign's dead-floor pattern in mirror image: not host surface kept as an
"irreducible floor" that nothing reaches, but a *migration target* kept warm by
its own unit tests. The distinction matters for how the ledger reads. K7's
Rust counts as +21k Rust and 0 TypeScript removed; on the campaign's primary
metric, V4, it has so far moved nothing, and it will move nothing until B2 and
B3 land together.

**The code comment already says this and deserves credit for it.**
`crates/kernel/src/wasm_api.rs` states plainly that
`SharedMappingTable::mappings` "is therefore empty in production today". The
claim was checked line by line during this census — including its assertion
that `kernel_shared_mapping_sysv_inherit` reaches the whole-subsystem
`inherit_process_mappings`, which an earlier pass of this census wrongly read
as false because the grep that tested it excluded `memory.rs`. It is true. The
comment is accurate; what was missing was any record of the consequence on the
B3 row.

### What B2 should do first, and why it is smaller than 1,068 lines

The census turned up the reason the coherence layer is expensive in
TypeScript, and it is not the policy — the policy is small. It is that **the
host does not know what the kernel knows, and pays to re-derive it.**

`getFdStatForSharedMapping` is **93 lines** that hand-assemble a synthetic
`fstat` syscall channel, lease scratch, re-enter the kernel through
`kernel_handle_channel`, and then recover the host file handle by *snooping
the kernel's own `host_fstat` call* through a
`beginFstatHandleCapture`/`finishFstatHandleCapture` side-channel in
`host/src/kernel.ts`. `getFdAccessModeForSharedMapping` is another **60 lines**
doing the same thing for one `F_GETFL`. Together with the `sharedMmapFdCache`
that exists only to amortise them, and `resolveSharedMmapPath` and
`findSharedMmapBackingForFd`, roughly **300 of the 1,068 lines do not need
porting at all** — they are host code re-deriving the fd's dev/ino/size/mode,
access mode, path, and host handle, every one of which the kernel already
owns in its own `OpenFileDesc`.

`handleSharedMappingsAfterFileSyscall` (171 lines) is the rest of the shape:
pure syscall-number-keyed invalidation policy with no host dependency beyond
those lookups, called from three sites in the host's dispatch. Driven from the
kernel's own dispatch it loses both the lookups and the three call sites.

So the cheapest correct first move for B2 is a single kernel export answering
the fd facts directly, which deletes ~150 lines of TypeScript and the snooping
side-channel with it. **It was scoped and deliberately not taken in this
run**: doing it without duplicating `sys_fstat`'s host-delegation logic
requires teaching `crates/runtime-core/src/syscalls.rs` to report which branch
answered, and that file is under active edit by the socket-readiness item.
It is B2's opening move, not a B3 deliverable.

### One hazard to carry into B2/B3

`sys_clone`'s pthread slots now reserve from
`MemoryManager::reserve_host_region` (`ca2ac5c0b`), the same first-fit
allocator that answers `mmap_anonymous`, and
`release_host_region` deliberately unmaps nothing. `SharedMappingTable` keys
its mappings by address. Once the table is non-empty, a released and re-issued
reservation can land on an address a stale mapping entry still names, so
teardown ordering between address-space release and mapping release becomes
load-bearing. This is not a defect today — the table is empty — which is
exactly why it needs recording now rather than discovering later.

### Performance was not measured

No benchmark was run for this item and none should be cited for it. The
unmeasured quantity is unchanged and named precisely: **the cost of the Rust
shared-mapping path relative to the host implementation it would replace**,
confined to a process holding a large writable `MAP_SHARED` with at least one
live peer and crossing syscall boundaries often. A general syscall benchmark
reaches only `synchronize_for_boundary`'s early-out and would be a true result
about the wrong code. Nothing in this change touches a hot path, so there is
nothing here to measure either.

## B2 opening move executed — the fd-facts export (2026-09-11)

**B2's opening move is landed.** `kernel_shared_mapping_fd_facts(pid, fd,
out_ptr, out_capacity)` writes one `KernelSharedMappingFdFacts` record — dev,
ino, size, host handle, mode, access mode, and whether the host handle is
meaningful — and the host stops re-deriving any of it.

Deleted with its callers:

- `getFdStatForSharedMapping` (93 lines): a hand-assembled synthetic `fstat`
  channel, a scratch lease, and a re-entry through `kernel_handle_channel`.
- `getFdAccessModeForSharedMapping` (60 lines): the same shape again for one
  `F_GETFL`.
- `beginFstatHandleCapture` / `finishFstatHandleCapture` in `host/src/kernel.ts`,
  the `fstatHandleCapture` field, and the write in `#hostFstat` that fed it —
  **the snooping side-channel is gone**, and with it a coupling that depended
  on exactly one `host_fstat` call happening inside exactly one synthetic
  dispatch, which nothing in the type system stated.

### The classification question, answered without duplicating `sys_fstat`

The B2 scope note said the export needed `crates/runtime-core/src/syscalls.rs`
taught "to report which branch answered" `sys_fstat`, and flagged that file as
under active edit. It does not need that, and the reason is worth recording:
**"which branch answered" is not the question the mapping layer is asking.**

What it needs to know is who owns the file's bytes. A `FileType::Regular`
descriptor carries a non-negative `host_handle` exactly when the host owns
them: every kernel-owned regular file is encoded in a negative handle band —
synthetic regulars, tmpfs, the rootfs overlay, procfs buffers, memfd — and
those are precisely the descriptors with no persistent host handle to anchor a
byte-store backing on. That is answerable from the OFD in three lines, and it
is the same predicate `fd_supports_mmap_writeback` already uses minus the
access check. `sys_fstat` was left untouched; the only change to `syscalls.rs`
is one additive `pub fn shared_mapping_fd_facts` immediately after
`fd_supports_mmap_writeback`, plus one additive unit test in the test module.

### Two behavior changes, both deliberate

1. **No signal-termination check.** The synthetic-channel form had one because
   it re-entered the channel dispatcher, which can complete a pending signal
   termination. A metadata query the host makes on its own behalf is not a
   syscall the guest issued and has no interruption point, so the `EINTR` the
   old path could return was an artifact of the mechanism, not POSIX `mmap`
   behavior.
2. **`prepareSharedMmapFromFile` makes fewer kernel round trips.** It used to
   make one for the identity and a second for the access mode, on every branch.
   It now makes one, because the facts record carries both.

### The recount — 21 sites, not 15, and the direction matters

The B3 atomicity finding rested on `backingKind` being tested at "15
interleaved sites". Recounted on this branch: **21 code sites** (23
occurrences, two of them type declarations). The recount moves the finding the
same way it already pointed, only further: an anon-only cutover would have to
leave more branches in TypeScript, not fewer.

Independently re-verified at the same time, because both claims gate the item:

- `track_anonymous_mapping`, `sync_anonymous_from_process`,
  `get_or_create_file_backing`, `synchronize_for_boundary`, `flush_mappings`,
  `cleanup_mappings`, `remap_mapping` and `release_all_for_process` each have
  **zero callers outside `memory.rs`**. The dead-floor mirror is real.
- `release_host_region` still frees only bookkeeping, and the range it frees is
  immediately reusable by `find_gap` — the same allocator `mmap_anonymous`
  uses. The teardown-ordering hazard recorded for B2/B3 is accurate as written.

### What remains, measured

The rest of the subsystem is **57 methods, ~2,500 lines** of method bodies in
`host/src/kernel-worker.ts`, plus type declarations and call sites. It is one
atomic item: `sharedMappings` is a single container holding both kinds, and
the lifecycle paths (inherit, cleanup, remap, release, flush, protection
update, exec preflight) branch on `backingKind` inside shared loops rather
than dispatching to separable halves.

Two candidates for a further separable slice were examined and **rejected**:

- `handleSharedMappingsAfterFileSyscall` (172 lines) is pure policy, but it
  opens by reading `sharedMmapBackings`, `sharedMmapFdCache` and the path
  index. It cannot move before the containers do.
- `sharedMmapFdCache` looked like dead weight once one cheap export replaced
  two kernel re-entries. It is not: it still saves a kernel call per file
  syscall for any process holding a file backing. Removing it is an unmeasured
  change to the syscall hot path, which this campaign does not do on judgment.

### Numbers for this increment

- Production TypeScript: **−94** hand-written lines in `host/src`
  (`kernel-worker.ts` +110/−171, `kernel.ts` −36, `kernel-scratch.ts` +3);
  `host/src/generated/abi.ts` adds 9 generated lines.
- Host imports: **73 functions plus `env.memory`**, before and after, read
  from the built kernel (74 import *entries* — the count that reads as an
  off-by-one).
- Driver glue: the new marshalling method is 83 lines including its doc
  comment, plus 3 lines of scratch-export registry and 8 import lines — about
  **+94 added, −153 removed**, so driver glue net **−59**.

### ABI

Additive: one export, `kernel_shared_mapping_fd_facts (i32,i32,i32,i32) ->
(i32)`. That is the entire `abi/snapshot.json` delta. No `ABI_VERSION` bump —
ABI 44 is unreleased and the change is purely additive to it.

### Performance still not measured

Unchanged and still named precisely: **the cost of the Rust shared-mapping
path relative to the host implementation it would replace**, for a process
holding a large writable `MAP_SHARED` with at least one live peer and crossing
syscall boundaries often. No benchmark was run for this increment and none
should be cited for it. A general syscall benchmark reaches only
`synchronize_for_boundary`'s early-out — a true result about the wrong code.
This increment removes one kernel re-entry from `mmap` preflight and one from
each file-mapping access-mode check; that was not measured either, and is not
claimed.

## B2+B3 policy layer landed, and the cutover is blocked behind it (2026-09-11)

> **Superseded 2026-09-11 by "Handle retention landed" below.** The four
> refusals this section records are implemented; the blocker it names is
> closed. The premise verification and the refcount finding here remain
> accurate and are what the follow-up built on.

**The coherence layer now exists in Rust, and the deletion still cannot be
performed.** The blocker is not the policy and not the benchmark. It is that
the kernel's `SharedMappingIo` deliberately refuses four of the capabilities
the file-backed halves need, so neither half can be made live no matter how
complete the policy is.

### The premise was re-verified before the work, and it held

The ordering for this item rested on the Rust never having executed. All three
claims were re-checked on this branch rather than inherited:

- The eight named `SharedMappingTable` methods have **zero** callers outside
  `memory.rs`. Confirmed by census: `track_anonymous_mapping`,
  `sync_anonymous_from_process`, `get_or_create_file_backing`,
  `synchronize_for_boundary`, `flush_mappings`, `cleanup_mappings`,
  `remap_mapping`, `release_all_for_process` — all zero.
- Every `kernel_shared_mapping_*` export is `_sysv_` apart from the opening
  move's `fd_facts`. Ten exports, confirmed in source.
- `inherit_process_mappings` **is** reached in production, over an empty map.
  A first grep said otherwise and was wrong: the call is indirect, from
  `kernel_shared_mapping_sysv_inherit` through `inherit_sysv_attachments`. The
  comment at `wasm_api.rs:7707` describes it as a direct call, which is what
  made the census hard; the claim it supports is correct.

### What the first execution over a non-empty table found

Driving fork, boundary sync, flush, mremap, partial unmap and teardown over one
process holding an anonymous **and** a file mapping exposed a reference-counting
invariant that no single-method test could see. `FileBacking` is created with
`ref_count: 0` and `get_or_create_file_backing` never counts the mapping that
caused it, while `track_anonymous_mapping` creates its backing and registers its
mapping together and so stays consistent. Creation counts nothing,
`inherit_process_mappings` counts each inherited mapping, `release_mapping`
discounts every mapping it drops — so the count runs one short for the life of
the mapping and **the first process to exit takes the backing to zero,
flushing and closing the host handle while a live peer still has the file
mapped.** Uncounted it is quieter still: two real peers both sit in the
sole-observer deferral and never see each other's writes, which is a silent
`MAP_SHARED` coherence failure. The host takes that reference in
`prepareSharedMmapFromFile`; the Rust registration path that would take it did
not exist, and now does.

### The blocker — four refusals in `WasmSharedMappingIo`

`crates/kernel/src/wasm_api.rs:1153` is the **only** production
`SharedMappingIo`. Four of its methods refuse by design:

| Method | Behavior | What it blocks |
|---|---|---|
| `retain_handle` | `ENOSYS` | **every** host-file-backed mapping |
| `fd_stat` | `ENOSYS` | the kernel-owned fd-writeback bridge |
| `fd_pwrite` | `ENOSYS` | fd-writeback flush |
| `close_fd` | no-op | the writeback dup's close |

`get_or_create_file_backing` calls `io.retain_handle(source_handle)?` on both
its creation and its writable-upgrade path (`memory.rs:2664`, `2677`) and
propagates the error, so **the first `MAP_SHARED` of a host-owned regular file
through the kernel returns `ENOSYS`.** The refusal is honest and its comment
says why: a retained handle must outlive the guest descriptor that opened it,
which requires deferring the kernel's own `host_close` until the last mapping
reference drops, and handing out a handle the kernel may close underneath the
caller would be worse than refusing.

**This was recorded once and never reached the step list.** The K7 re-cut note
says `retain_handle`/fd-writeback "were described as existing and did not, and
now refuse with `ENOSYS`". It was written as a correction to that note's own
claims, not as a prerequisite on the B2/B3 row, so the item was scoped as
policy → exports → deletion with this step missing from the middle. It is the
same failure mode the K7 mis-scope is filed under: **silence in a work contract
reads as completeness.**

### Consequently the remaining order is not what the item assumed

Handle retention is a prerequisite, not a follow-up. It touches host-handle
lifetime across `close`, OFD release and process teardown — `process_table.rs`
already refcounts OFDs so that "only the last process queues the underlying
`host_close`", and what is missing is a mapping-held reference layered on top
of that. Until it lands, adding the ~10 kernel exports would grow the ABI
surface with entry points that cannot succeed, which is the opposite of what
this campaign is for.

### Numbers for this increment

- Production TypeScript: **0**. Nothing was deleted, because the deletion is
  gated on the blocker above. The item exists to make this number strongly
  negative and it has not yet moved.
- Host imports: **73 functions plus `env.memory`**, before and after, read from
  the built kernel (74 import *entries*).
- Driver glue: **0**.
- Rust: **+1,729** lines — `shared_mapping_policy.rs` is new at 1,108 (501
  production, 607 tests) and `memory.rs` gains 620 (the reload family and the
  keyed wrappers, the rest tests). Roughly 700 production to 1,030 test, which
  is the ratio this item wanted: the Rust it hands the subsystem to had never
  run.

### ABI

**No delta at all.** `xtask dump-abi` over the freshly built kernel left
`abi/snapshot.json` and every generated file byte-identical — the working tree
was clean after regeneration. No `ABI_VERSION` bump, and the gate was run
rather than reasoned about.

### Performance was not measured

Unchanged and still named precisely: **the cost of the Rust shared-mapping path
relative to the host implementation it would replace**, for a process holding a
large writable `MAP_SHARED` with at least one live peer and crossing syscall
boundaries often. No benchmark was run and none should be cited. A general
syscall benchmark reaches only `synchronize_for_boundary`'s early-out — a true
result about the wrong code. Nothing added here has a production caller yet, so
there is also nothing here that could have been measured in place.

## Handle retention landed — the mapping cutover is unblocked (2026-09-11)

**The four refusals are gone and none of them cost a host import.** The
previous increment recorded that `WasmSharedMappingIo` refused
`retain_handle`, `fd_stat`, `fd_pwrite` and `close_fd`, so neither half of the
file-backed mapping subsystem could be made live however complete the policy
was. All five methods are now implemented, and the host import count is
unchanged at **73 functions plus `env.memory`** — verified name for name, not
merely counted, by diffing the import sections of two kernels built from the
trees on either side of the change.

### Every premise was re-verified on the branch before anything was built

- **Only one production `SharedMappingIo`.** Confirmed: `wasm_api.rs:1153`.
  The two other impls are `#[cfg(test)]` doubles, in `memory.rs` and
  `shared_mapping_policy.rs`.
- **`get_or_create_file_backing` calls `io.retain_handle(...)?` on both
  paths.** Confirmed at `memory.rs:2664` and `:2677`, both propagating.
- **`process_table.rs` already refcounts OFDs so only the last process queues
  the underlying `host_close`.** Confirmed at `process_table.rs:582-596`,
  backed by `ofd.rs`'s `HOST_HANDLE_REFS`, where a handle *absent* from the map
  means "count of 1, safe to close".

One inherited premise had **already been fixed** and the ledger did not say so.
The reference-counting asymmetry recorded last increment — `FileBacking`
created at `ref_count: 0` with nothing counting the mapping that caused it — is
closed by `shared_mapping_policy::acquire_file_backing`, which landed in
`5f0304fcc` in the same increment that wrote the finding. This change therefore
**built on the fix rather than repeating it**, and closed the remaining hazard
with a doc note: `get_or_create_file_backing` still hands back an uncounted
backing, which was harmless while the method could not succeed in production
and is a live trap now that it can.

### The design, and the mistake it avoids

A mapping-held reference is a **second, independent count** layered on the
cross-process descriptor refcount, not a bump of it. Two reasons, the second
sharper than the first:

- the cross-process count reaching zero is exactly the moment a single-process
  mapping still needs the handle, so there is nothing there to piggyback on;
- `release_ofd_reference_impl` performs `release_final_ofd_locks` inside the
  same branch that performs the close. Deferring within that count would keep
  an `F_OFD_SETLK` record alive for as long as the file stayed mapped. POSIX
  releases the *description*'s locks when the description ends; the extra
  reference `mmap` takes is on the **file**, not on the description.

So the description ends on time — OFD freed, fd number reusable, locks gone —
and only the physical `host_close` is withheld and marked owed to the last
mapping reference. Three sites consult the table, each chosen where the
close is *decided* rather than where it is drained, so no drain site can
reintroduce the bug: the final OFD release (`syscalls.rs`), teardown of a
process that never reached `sys_exit` (`process_table.rs`), and release of
a descriptor queued in SCM_RIGHTS (`pipe.rs`).

The fd-writeback trio needed no new mechanism at all. It serves files the
kernel owns itself, which have no stable host handle to map, so it reaches them
the way a guest would: `shared_mapping_fd_facts`, `sys_pwrite`,
`sys_close_with_locks`. The TypeScript being replaced re-entered the
kernel with a synthesized `SYS_CLOSE` channel record to do the same thing.

### Every guard was mutation-tested, and one of them was not a guard

Five guards were added. Each was removed, shown failing, and restored:

| Mutation | What it said |
|---|---|
| drop the negative-handle refusal | `left: Ok(()) right: Err(EBADF)` |
| drop the already-owed-close refusal | `left: Ok(()) right: Err(EBADF)` |
| drop the deferral at the final OFD release | `a mapped file's handle must not be closed while the mapping lives; closed [100]` |
| drop the deferral at teardown | `teardown queued a close for a handle a mapping still holds: [0, 1, 2, 9452200]` |
| fold the lock release inside the deferral | `the description ended, so its OFD lock must be gone even though the file is still mapped` |

The fifth is the one worth recording. It **passed** on the first attempt, which
meant the lock assertion was decorative. The test took a POSIX record lock,
which is process-owned and cleaned up on a path no ordering of the deferral can
reach; it now takes an OFD lock, whose removal is precisely what
`release_final_ofd_locks` performs. The assertion that justifies the whole
two-counts design was, until that mutation ran, asserting nothing.

### Numbers

- Production TypeScript: **0**, and that is the honest figure. This is a
  prerequisite, not a deletion; its payoff is that B2+B3 can now proceed.
  `kernel.ts`'s `retainedHostFileHandles`/`descriptorClosePending` and
  `kernel-worker.ts`'s writeback-dup refcount become deletable *with* that
  cutover, not before it, because the host is still driving mappings today.
- Host imports: **73 functions plus `env.memory`**, before and after, import
  sections diffed name for name.
- Driver glue: **0**.
- Rust: +546 / −32 across six files, roughly a third production and two thirds
  tests.

### ABI

**No delta.** `xtask dump-abi` over the freshly built kernel left
`abi/snapshot.json` and every generated file byte-identical; the working tree
held only the six source files after regeneration. No `ABI_VERSION` bump.

### Inert until the cutover wires it up, and that is deliberate

Nothing populates the retention table in production yet: the exports that would
call `retain_handle` are what B2+B3 adds. `host_close_deferred_by_mapping`
therefore answers "not deferred" for every handle today, so the close paths
behave exactly as they did. That is a property worth keeping in mind when
reading the validation — the suites prove the mechanism is correct, not that it
is exercised by a running machine. The first thing the cutover should do is
re-run this file's tests with the exports live.

### Performance was not measured

Unchanged from the previous increment and named the same way: the cost of the
Rust shared-mapping path relative to the host implementation it would replace.
Nothing added here has a production caller, so there is nothing here that could
have been measured in place.

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

**It does not isolate everything, and the gap was measured on 2026-09-10.**
`KANDELO_SOURCE_CACHE_ROOT` redirects the `source-only` tier. It does **not**
redirect `$HOME/.cache/kandelo/programs`, which is where package builds install
their resolver scratch: a `./run.sh rebuild rootfs` under an isolated cache
root was still observed writing
`/Users/<user>/.cache/kandelo/programs/.findutils-…`. So concurrent agents
still share that directory, and a stale entry there surfaces as
`artifact lacks an __abi_version export — legacy binary predates the ABI
marker rollout` in unrelated suites. Setting the cache root and then treating
every artifact as private is the mistake to avoid.

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
| K11 piece 3 | Kernel-side cmdbuf validation and the trimmed `webgl/bridge.ts` walk — Node-tested only; no real `WebGLRenderingContext` anywhere in Vitest. |
| K11 pieces 2/4 | Ruled immovable; the `http1.ts` framing dedup and the duplicate-`Content-Length` fix are browser-only paths, proven under Node only. |
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
| 4 | `thread-allocator.ts` | 186 | **V2/V4 — DONE 2026-09-10.** The quota moved into the kernel (A4), then placement did (A9): `sys_clone` reserves the slot from `MemoryManager::reserve_host_region`. The file is 96 lines of "grow the Memory to cover this address, zero it" — the part only a host can do — with no arena, no free list and no quota |
| 5 | `vfs/device-fs.ts` | 339 | **V4** — delete the *host copy*; `/dev` stays, served by `crates/runtime-core/src/devfs.rs`. See duplicated authority #2 below |
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

## Three unowned census findings, resolved 2026-09-10

### `networking/hostname.ts` — MIGRATED, 99 lines → 33

`sys_getaddrinfo` did no name interpretation at all: it handed the caller's
bytes to `host_getaddrinfo` and trusted the answer, so a name's *meaning* was
decided by whichever backend was attached. Four backends each carried a copy of
`inet_aton(3)` and DNS syntax.

`crates/runtime-core/src/hostname.rs` implements the grammar **from the
specification**, and the specification disagrees with the TypeScript twice:
`010.010.010.010` is `8.8.8.8`, not `10.10.10.10` (each part is a C integer
constant, so a leading zero is octal — which is also what the musl `inet_aton`
above this kernel answers, via `strtoul(s, &z, 0)`), and `0x7f.1` is
`127.0.0.1` rather than a DNS name. **Both divergences are guest-observable
through a direct `SYS_getaddrinfo`**; `getaddrinfo(3)` itself does not reach
them, because `libc/musl-overlay/src/network/lookup_name.c:61` calls
`__lookup_ipliteral` before the syscall.

A failed numeric parse does not make a string a host name: RFC 1123 §2.1 says a
valid host name never has the dotted-decimal form, because its top-level label
is alphabetic. `validate_dns_hostname` applies that to the top-level label,
which keeps `256.1` from reaching a resolver as it did not before, and
generalises to `example.123`, which the TypeScript would have looked up.

What stays host-side is the `.invalid` refusal (RFC 6761 §6.4) that a backend
which *fabricates* a synthetic address and defers the lookup to `fetch()` must
make up front, overridable by the host's own alias table — host configuration
the kernel is never given.

### `vfs/device-fs.ts` — the "unreachable" claim was FALSE. Sixteenth disproved floor, in the other direction

The census recorded `DeviceFileSystem` as already-dead code kept mounted for
appearance. **It was live.** The thirteen `is_devfs_namespace_path` guards are
real and do cover open/stat/readdir/statfs/pathconf and every mutation, but
**three syscalls were never on that list**, and `hostdir` anchors on the
directory handle each mount publishes at boot — so each carried a resolved
`/dev` path into the host's device table:

- `readlink`/`readlinkat` → `hostdir::readlink`. The host answered EINVAL,
  which is the right errno, which is why nobody noticed.
- **`bind(AF_UNIX)` → a live defect.** The kernel asks the host to create the
  socket inode with `O_CREAT | O_EXCL` *precisely* so a pre-existing path
  becomes EADDRINUSE, and the host backend ignored its open flags. So
  `bind(fd, "/dev/null")` **succeeded**, registering an endpoint at a path
  `unlink` then refuses to remove because unlink under `/dev` is EROFS.
- `execve` via `open_prepared_exec_target` → EACCES for the devices the host
  table happened to carry, ENOENT for the ones it did not.

Plus `foreignMountRoots` ran `DeviceFileSystem.statfs("/")` once per boot on
both hosts. So the file executed on every session.

Fixed in the kernel first (`d461cc70f`), then unmounted and deleted
(`a259fd3de`). The divergences the census listed — `/dev/full`, `/dev/console`
as ENXIO vs Null, `SUBDIRS` vs `DevfsEntry` — turned out **not** to be a
behaviour question, because none of the three leaking syscalls consults a node
table: they resolve first, and resolution was already kernel-only. `/dev/console`
answered as the kernel's Null before the change and after it.

One kernel change made the unmount safe: `rootfs::owns_path` now consults
`devfs::owns_path` the way it already consults `tmpfs::owns_path`. The overlay
previously left `/dev` alone only because the *hosts* declared their mount
points as foreign prefixes, so dropping the mount would have let the overlay
claim a kernel-owned namespace.

### `boot-descriptor.ts` — NEEDS-DEFER-DECISION, not started

Runs on the browser main thread with **no kernel instance in existence**, so it
cannot be a kernel export. Full argument and call sites in the disposition
ledger's 2026-09-10 correction. The `detectPtrWidth` precedent cited for it does
not exist — `detectPtrWidth` is plain TypeScript.

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

## NDD-K4-3 — executed, and the census that framed it was inverted

**The brief's counts were backwards.** NDD-K4-3 recorded "twenty differing
declarations ... plus sixteen byte-identical state declarations". Measured at
`d6f4f188f` with the TypeScript parser rather than by name: **36 common — 20
byte-identical, 16 differing**, holding 1,118 node and 1,511 browser lines.
A first pass with a hand-written brace counter reproduced the wrong shape by
silently swallowing `handleExec` and `handleInit` into a preceding
declaration, which is the same failure mode this plan already records for
name-based census: a structural count needs a real parser, not a regex.

**After this item: 21 common — 8 byte-identical, 13 differing**, holding
**349 node and 746 browser** lines. The duplicated declaration mass fell 69%
on Node and 51% in the browser. The entries went 2,186 → 1,408 (node) and
2,576 → 1,810 (browser); `process-lifecycle.ts` went 3,696 → 4,794.

### The three numbers

1. **Production TypeScript: −446** (`migration-ledger.sh --step d6f4f188f
   HEAD`: 1,372 added / 1,818 removed, in-scope). Rust unchanged.
2. **Host import count: 75 before, 75 after — measured, not inherited.**
   The kernel was rebuilt at this tip and its import section decoded
   directly: **76 entries, of which 1 is `env.memory` and 75 are `env`
   functions.** That matches `EXPECTED_HOST_IMPORT_COUNT` in
   `crates/host-native/src/lib.rs`. Worth recording that the constant counts
   imported *functions*, so a decoder that reports the raw entry count reads
   76 and looks like an off-by-one regression when nothing has changed.
3. **Driver-glue delta: 0.** Nothing here instantiates, drives or marshals
   for a Rust module. Every line added to `host/src` is process-lifecycle
   logic that left the two entries.

**And a fourth, which is the one the plan says to rank on.**
`ProcessLifecycleHost` went **37 members → 28, a net −9**: ten pass-through
fields removed, one optional hook added. That record is the host surface this
campaign exists to shrink, so this item shrinks the contract rather than
relocating line counts.

### What was shared, and what was refused

| group | outcome |
|---|---|
| realm state (11 declarations) | shared — constructed in the module, returned; −10 host fields |
| `handleExec` (458/493) | shared whole |
| `handleInit` (267/504) | **middle only** — callback record, allocator, rootfs/overlay wiring |
| `handleHttpRequest` (15/53) | **refused** — a name collision, not a duplicate |
| `installProcessWorkerListeners` (98/168) | message dispatch shared; error/exit disposition declared |
| `performDestroy` (133/143) | prologue, retry sweep and allocator accounting shared; retirement loop left — see NDD-K4-4 |

**`handleHttpRequest` is not a duplicated declaration and should stop being
counted as one.** Node's answers a kernel-worker protocol request through
`respond`/`respondError`; the browser's is a service-worker bridge dispatcher
that resolves a listener port, posts to a `MessagePort` and tracks bridge
activity. They do not share a signature. The only thing in common is one call
to an existing kernel method.

### Eight drifts closed, each toward the half that was right

| drift | halves | resolution |
|---|---|---|
| exec retirement predicate | Node `mainQuiescent && threadsQuiescent`; browser also required `memoryRetirementSafe` and the framebuffer-alias release | browser's — the complete predicate, written once through `releaseGenerationAliases` |
| exec's old-worker teardown | Node `terminateTrackedWorker`; browser an inline copy missing the `workerTeardowns` registration | Node's — the browser's exec teardown was invisible to the rootfs-export quiescence predicate |
| exec handoff reap signal | browser named the signal; Node passed `undefined` and relied on a synthesis it does not perform on this path | browser's — strictly more precise, idempotent via `hostReaped` |
| detach ledger | browser dropped the PID from `threadedProcessPids`; Node did not | browser's — Node's omission was documented inert but grew a `Set` for the realm's life |
| exec thread-settle ledger | same, at the exec commit and in its rollback | browser's |
| exec allocation diagnostic | browser passed operation/path/argv; Node passed none | browser's — a capacity failure named only a PID on Node |
| worker-message PID guard | Node guarded `message.pid === pid` on the ownership fences; browser did not | Node's — a message naming another PID would have settled this PID's fence |
| allocator page size | browser used a hand-written `PAGE_SIZE = 65536`; Node used generated `WASM_PAGE_SIZE` | Node's — a hand-written copy of an ABI constant stops matching silently |
| retained-generation diagnostic | browser formatted with a stack, Node without | browser's — a generation the host could not give back is worth a stack |
| generation-exhaustion message | browser said "browser process execution generation space exhausted" | Node's host-neutral wording; `diagnosticPrefix` already names the host |

### Two boundaries declared rather than collapsed

**The exec rollback's lease release.** Node released exactly, the browser
force-retires after a start attempt. Node's comment claimed its exact release
was safe because the replacement "was never started" — that is **false**, and
the same comment said so two sentences later: `preparedTransferred` is set
*after* `start()`. Both behaviours are kept and derived from
`terminationProvesQuiescence`, which is what actually distinguishes them.

**The process-worker error/exit disposition.** Node's `terminate()` is an
ownership fence; the browser's is not and delivers no `exit` event at all, so
`BrowserWorkerHandle` fabricates one and the listener needs a latch to stop
the fabricated event double-finalizing. `dispatchProcessWorkerMessage` returns
a disposition rather than acting on it.

### NEEDS-DEFER-DECISION (NDD-K4-4) — `retireCurrentGenerations`

- *What:* the generation-retirement loop inside `performDestroy`, ~45 lines
  in each entry, the only substantial piece of NDD-K4-3 left unshared.
- *Why it was not taken:* the halves differ on the load-bearing decision, not
  on wording. Node awaits `waitForWorkerQuiescence` and
  `terminateThreadWorkers` and releases the lease **exactly** when both report
  quiescent. The browser does not call `waitForWorkerQuiescence` at all,
  releases the main-thread framebuffer alias, and **always** force-retires.
  A shared form must make the browser start awaiting a quiescence fence it
  does not await today — a change to browser teardown timing that no Node
  suite can prove.
- *Cost now:* a careful session plus a real browser teardown pass, including
  the Safari image-switch reclamation path this code exists to protect.
- *Cost later:* small. It is now ~45 lines rather than 133/143, it sits
  between three shared helpers, and the two halves are adjacent in the diff.
- *Also here:* D15 remains un-adjudicated — the browser's
  `waitForProcessTeardowns()` barrier, called twice, where Node uses one
  `Promise.allSettled` over `processTeardowns`.
- *Recommendation:* take it with the browser teardown pass, not before.
  **The maintainer's call, not the agent's.**

### Structural parity assertions: six suites repointed

Fourteen assertions in five suites slice named functions out of the entries as
text and failed on a `-1` index once those slices moved. Each was repointed at
`process-lifecycle.ts` and paired with a check that the entry still binds or
spreads what it delegates. `kernel-worker-entry-root-contract`'s callback-name
walker now resolves a spread of `processLifecycleKernelCallbacks()` to the
names that record declares.

One assertion split rather than moved: of the five creator-gate admissions,
four reach the kernel through the shared callback record, but
`a host-spawned process Worker` arrives as a `spawn` message from main rather
than through a kernel callback, so it stays each entry's to admit.

### Validation actually run

All inside `./scripts/dev-shell.sh`, vitest from `host/` via
`host/node_modules/.bin/vitest`, with an isolated
`KANDELO_SOURCE_CACHE_ROOT` verified from inside the shell.

- **`npm --prefix host run typecheck`: clean**, matching the 0 baseline, at
  every one of the five commits.
- **`npm --prefix host run build`: green** at every commit — it checks
  emitted declarations and bundling, which typecheck does not.
- **Nine host-parity/contract suites, before and after, in this worktree:**
  at base `d6f4f188f` 8 files passed / 1 failed; at the tip 8 files passed /
  1 failed — the same file (`host-owned-process-reap`) and the same two
  cases. 63 passed / 2 failed of 65. The base was measured minutes before,
  not inherited.
- **Nine worker-lifecycle/entry suites, before and after, in this worktree:**
  **16 failed / 102 passed of 118 at BOTH** `d6f4f188f` and the tip — the
  same six files (`environment-lifecycle`, `ordinary-process-exit`,
  `process-wait-lifecycle`, `spawn-credential-order`, `spawn-pid-authority`,
  `vfork-lifecycle-guest`) and the same counts. Five of the six are the
  pre-existing set this plan already names. The sixth,
  `vfork-lifecycle-guest`, fails at *both* revisions with
  `rootfsImage:"default" requested but no rootfs image was available` — it
  never collects a test, because this worktree has no `host/wasm/rootfs.vfs`.
  That is provisioning, not a regression, and it means **the suite the
  previous tranche called the gate for exactly this kind of change did not
  execute here either.** `./run.sh rebuild rootfs` was started to close that
  and **did** finish — it builds the rootfs package set from source (sudo,
  bash, ncurses, …) and is far longer than the plan's provisioning list
  implies, but it is a provisioning step, not a boundary.
- **The fork-path guest gate then ran, and is GREEN.** With
  `host/wasm/rootfs.vfs` present, three kernel-booting suites, at base
  `d6f4f188f` and at the tip: **8 passed / 1 failed of 9 at both**, the same
  single case (`fifo-lifecycle-guest` → "rendezvouses across processes and
  cancels an exact blocked thread").
  **`vfork-lifecycle-guest` passes 6 of 6 at the tip**, including "contains a
  compute-running borrower after an external fatal signal", which drives the
  shared `containVforkAddressSpace`, and "keeps the parent parked through exit
  and failed exec, then releases on exec", which drives the shared
  `handleExec` and `finishProcessExit` on the vfork-borrower path.
  `wait-lifecycle-guest` passes 2 of 2. This is the gate the previous tranche
  recommended provisioning before taking this family, and it is the first time
  in this item that the newly shared exec path was executed by a real guest
  rather than asserted about.
- **Browser: NOT run.** Every group here has a browser half that Node cannot
  execute: the exec retirement predicate's alias release, the fabricated
  `exit` event and its latch, `handleInit`'s side-module compilation and
  bridge wiring, and browser teardown.
- **Kernel import count: verified.** `./run.sh rebuild kernel` at this tip,
  then the import section of the resulting `kandelo-kernel.wasm` decoded
  directly: 75 `env` function imports, unchanged.
- **Conformance suites: not run.** Still unreachable behind the tier-identity
  defect; `xtask build-deps` failed once mid-session with "program package
  index target changed before publication: local mirror identity or contents
  changed", which is that defect surfacing through the shared
  `~/.cache/kandelo` mirror under concurrent agents.

### A cross-worktree hazard worth recording

**Serena's project root is not the agent's worktree.** Its editing tools wrote
into `/Users/brandon/kandelo-abi44-reconcile` — the shared checkout — while
this agent was isolated in
`.claude/worktrees/agent-a48f77ffe1c2a613b`, and reported success for every
edit. Nine edits landed in the wrong tree before a `git diff` in the right one
came back empty and exposed it. They were reverted by restoring the two files
from the agent's own pristine copies, verified by `diff -rq` over `host/src`
leaving only a concurrent agent's `binary-resolver.ts` untouched.

The bash-level worktree guard does not cover MCP tools. An agent given a
worktree should confirm early that every editing tool it intends to use writes
there — a single `git diff --stat` after the first edit is enough, and would
have caught this immediately.

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

### A. Dispatched batch — final state (audited 2026-09-10, after the merge wave)

| # | Item | State |
|---|---|---|
| A1 | K5 I6c — six missing `DynamicLinker` host↔module contracts | **DONE, merged.** `dylink.ts` 4,188 + `dylink-fork-archive.ts` 2,152 deleted |
| A2 | `crates/wasm-artifact` side module + cutover | **DONE, merged.** `constants.ts` 3,041 → 294 |
| A3 | K4b — remaining worker-entry declarations (21, not 16) | **DONE, merged.** Left NDD-K4-3 open |
| A4 | pthread slot arena unification + dead surface | **DONE, merged.** `shell-config.ts` deleted; `host_call_signal_handler` struck, imports **76 → 75**. The NDD on slot *placement* was dispatched and is now **DONE** — see A9 |
| A5 | Reconciliation — `usePolling` + poller, 16 memory-authority sites, epoch strings | **DONE, merged** |
| A6 | `hostname.ts` MIGRATE · `device-fs.ts` — delete the host copy, `/dev` stays kernel-served · `boot-descriptor.ts` scope-check | **DONE, merge pending** — `d5f2ba584..f88504243`, TS −421 / Rust +560. Boot descriptor **not started** — NDD-BOOT-1 below |
| A7 | **B7** — epoll instances to OFD ownership; fork inheritance | **DONE, merged.** Unblocks B6. Explicitly **not** conformance-validated — rests on 8 unit tests |
| A8 | **B17+B18+B19** — `tar/wasm32` compile, root npm install, stale-tier install | B17 and B18 closed. **B19 did not close** — the same ID now names a different, measured defect. See B19 below |
| A9 | A4's NDD — move pthread slot **placement** into `sys_clone` | **DONE.** Kernel places, hosts grow/zero/launch. host-native's fixed 16-slot arena and `RESERVED_THREAD_SLOTS` deleted; its `brk_base` now matches `computeProcessMemoryLayout` byte for byte, and it reads `__wasm_posix_thread_slots` like the JavaScript hosts. Two additive exports, no ABI bump |

**Nothing is in flight as of this line.** The next dispatch comes from B.

Two findings the batch produced that are not items:

- **A4 disproved its own predicted cause.** The 17-thread divergence was a
  `__tl_lock` deadlock at round *2* on native: `sys_clone` accepted and dropped
  `CLONE_PARENT_SETTID`, so `pthread.tid` stayed 0 and musl read equal zeros as
  a recursive acquire. Native's real pthread limit was **one**; the 16-slot
  arena was unreachable. Node was masked because `kernel-worker.ts` wrote ptid
  itself — a third instance of the "dead floor" pattern.
- **A6 disproved `/dev` unreachability.** Three syscalls were missing from the
  devfs guard list. One was live: the host backend ignores `O_EXCL`, so
  `bind(fd, "/dev/null")` **succeeded**, registering an endpoint at a path
  `unlink` refuses to remove (EROFS). Fixed in the kernel before deletion.

### How the next item is chosen — REVISED 2026-09-10

The original Tier 1/2/3 structure was built around the K-items and they are all
done. What follows is ordered by the rule below, which comes from the
maintainer's four goals and from the two lessons this campaign has paid for.

**Lesson one: deletion is what counts, not migration.** An item that moves
logic to Rust and leaves the TypeScript in place scores zero.

**Lesson two, added 2026-09-10 after the ledger was measured properly:
deleting TypeScript is not sufficient either.** Production TypeScript is net
−2,460 for the whole campaign because ~9,900 lines of *new host driver glue*
offset the deletions. A TypeScript `ld.so` of 4,188 lines was deleted and a
TypeScript dylink **driver** of 3,666 lines was added. On the old ordering that
item scored well. Against V4 — minimize the host API surface so a new host is
cheap to write — it barely moved, because every one of those lines is surface a
wasmtime host must reimplement.

**So every item is now ranked by net host-surface change, not by lines
deleted**, and every agent must report three numbers, not one:

1. production TypeScript delta,
2. host import count before and after,
3. **driver-glue delta** — lines added to `host/src` that exist to instantiate,
   drive, or marshal for a Rust module.

An item that deletes 2,000 lines while adding 1,800 lines of glue is now
ranked below one that deletes 400 and adds none.

**The order:**

1. **Ship blockers.** Anything failing the test suite or the build. B19/B23 is
   here and is currently gating the entire host suite.
2. **Unblockers.** B7 gated B6 and is done. B3 is gated on a benchmark that
   does not exist.
3. **Force multipliers.** Items that keep costing agent hours repeatedly and
   produce failures naming something other than their cause.
4. **Shrinks host surface** — B9, and any item that retires driver glue.
5. **Deletes TypeScript without adding glue** — B1 (completes V3), B12 (done),
   B5, B2.
6. **Correctness found along the way** — B11, B14.

**Parallelism is bounded by two things, neither of which is agent count:**
shared foundation files (`local_build.rs`, `rootfs.rs`, `wasm_api.rs`,
`kernel-worker.ts` — where *both* design collisions landed, not in the leaf
files agents were assigned), and the coordinator's serial merge throughput.
Batch by file locality, and never start two items that restructure one
foundation file.

### The ship gate (2026-09-10)

The maintainer's stated plan: **finish this campaign, ship it as PR #1350 once
bugs and test failures are addressed, then open a separate campaign to
minimize the driver glue.** The glue audit wants evidence that does not exist
yet — a second real host built against a stable baseline — so shipping first is
what makes that audit empirical rather than theoretical.

The gate is therefore:

- host Vitest suite green, **run from `host/` so `host/vitest.config.ts`
  loads** (see the trap below),
- `cargo test -p runtime-core -p kandelo -p host-native` green,
- typecheck 0 (held),
- `xtask verify-fresh` exit 0,
- the maintainer's own manual browser check.

## B22 CLOSED — it was never a repository defect

Reported as "libc-test's submodule URL is `git@github.com:` and ssh is
unavailable in the dev shell", and recorded here as a second independent reason
no conformance suite had run this campaign. **Both halves were wrong.**

`.gitmodules` has always said
`url = https://github.com/PocketCluster/libc-test.git`. What this *checkout*
had was two pieces of broken local state:

1. `.git/config` carried a stale override,
   `submodule.libc-test.url git@github.com:PocketCluster/libc-test.git`,
   which `git submodule sync` clears.
2. The submodule's own `.git` had been renamed to `.git.disabled`, so the
   directory was not a git repository at all, and `git submodule update` then
   failed with *"destination path already exists and is not an empty
   directory"* — a message about the wrong thing entirely. Restoring it also
   required repointing the gitfile: it held the relative path
   `../../../.git/modules/libc-test`, which is correct in a normal clone and
   wrong inside a `git worktree`, where `.git` is a file rather than a
   directory.

After repair: **925 tracked files, 0 missing, HEAD exactly the
`790f94c7b6feb8ade25868c10fba46233f783a0b` the parent expects.**

**The lesson is the one this day keeps teaching.** An agent looked at a real
symptom, formed a specific and plausible diagnosis — an ssh-only submodule URL
committed to the repository — and was wrong, because the environment was
broken in a way the error message misdescribed. That is the fourth such case
today, after vitest from the wrong directory (269 fictional failures), xtask
outside the dev shell (fictional ABI drift), and two agents working from the
campaign merge-base. **A broken environment does not report itself as a broken
environment; it reports as a defect in whatever it was pointed at.**

## The eleventh silent-success defect — `host-native` scores no-kernel as green

Found by the resolver agent while proving its own work.

`cargo test -p host-native` reports **54 passed, 0 failed** in a worktree with
**no `kernel.wasm` in any tier**. `kernel_path_or_skip()` returns `None`, and
every kernel smoke test then returns `Ok(())`. A tree with no kernel at all is
indistinguishable from a fully working one.

This matters beyond the usual, because `host-native`'s suite is the campaign's
only executable check that the kernel *loads* — and the maintainer intends to
ship on the strength of these gates. It was left unchanged deliberately:
making the skip fail turns ~53 tests red in any worktree without a kernel,
which is a maintainer decision, not an agent's. The skip message now prints
every tier it searched.

**This session's own `host-native` numbers are unaffected and were checked:**
the 39 failures before the kernel was rebuilt were
`failed to find function export kernel_thread_parent_tid_target`, which only a
loaded kernel can produce, and `local-binaries/kernel.wasm` resolves to a real
generation now. The measurement was real. The gate is still blind.

## Merge wave 2 landed (2026-09-10)

| item | result |
|---|---|
| T1 — resolver, one tier order | the source-only tier was never given its own arm; every path refused. Now routed through the projection authority it already carries |
| T2 — `browser-kernel.test.ts` | 33 failed → **43 passed**; the vitest stub now emits a distinct URL per import source |
| B5/K11 — devices | **−3,584 TypeScript**, +626 Rust; GL cmdbuf validation cut over; a 3,556-line dead TLS backend deleted |

**Ledger after this wave: production TypeScript −3,129** (from −2,460), host
imports **75**, typecheck **0**, Rust 1,944 + 54 + 6 passing.

## K7's Rust has never run — the dead-floor pattern, mirrored

Found by the B3 attempt, verified two independent ways and worth more than the
item it came from.

1. **Call-site census across `crates/`:** 15 `SharedMappingTable` methods have
   **zero callers** outside `memory.rs` — 874 lines of bodies.
   `inherit_process_mappings` (162 lines) *is* reached in production via
   `inherit_sysv_attachments`, but only ever over an empty map. `FileBacking`'s
   page cache adds ~283 more.
2. **The built artifact:** all nine `kernel_shared_mapping_*` exports are
   `_sysv_`. There is **no entry point into the other half at all**.

**Roughly 1,300 lines of Rust that has never run outside a test.**

This campaign has found four dead-floor instances in *host* surface — code kept
as "the irreducible floor" that no live path reached. This is the same pattern
**mirrored onto a migration target**: Rust written to receive a cutover that
never came. It is the mirror image of the dormant `wait_queue.rs` /
`wait_shadow.rs` pair, and it changes how K7's ledger row should be read: K7
counts as **+21k Rust with 0 TypeScript removed**, and against V4 it has so far
moved nothing.

The `wasm_api.rs` comment already said the table is empty in production, and it
is accurate — the agent checked it line by line and nearly filed a false defect
against it when an earlier grep excluded `memory.rs`. What was missing was any
record of the *consequence* where the work is tracked.

### B3 is atomic with B2 — the re-cut should have been two items, not three

The benchmark was never the binding gate; the maintainer's ruling removed a gate
that was not the one holding this shut.

**The anon half is not separable the way SysV was.** SysV was separable because
it owned its own containers. Anon and file mappings share one `sharedMappings`
container and are distinguished only by a `backingKind` field tested at
**15 interleaved sites** across the shared inherit/cleanup/remap/release/flush
paths. An anon-only cutover leaves every branch in TypeScript, adds a kernel
call inside each `anonymous` arm, and creates **two authorities over one address
space** — deleting ~100 lines while adding more in glue. On the campaign's own
surface-aware ranking that scores *below doing nothing*, so it was not done.

**B2 is cheaper than its estimate.** About 300 of its ~1,068 lines are host code
re-deriving facts the kernel already owns. The exhibit:
`getFdStatForSharedMapping` is 93 lines that hand-assemble a synthetic `fstat`
channel, re-enter through `kernel_handle_channel`, and then recover the host
handle by **snooping the kernel's own `host_fstat` call** through a
`beginFstatHandleCapture`/`finishFstatHandleCapture` side-channel in
`kernel.ts`. `getFdAccessModeForSharedMapping` is 60 more doing the same for one
`F_GETFL`.

**Recommendation, adopted:** merge B2 and B3 into **one** item, sized as B2's
estimate plus the cutover, dispatched with the fd-facts kernel export as its
first commit. **Do not dispatch B3 alone again — it will fail the same way a
third time.**

**Blocked on file locality, not on judgement:** that first commit needs
`crates/runtime-core/src/syscalls.rs`, which B8 (the wait-queue cutover) now
holds. Dispatch when B8 lands.

### A hazard recorded before it becomes a defect

pthread slots now reserve from the same first-fit allocator that answers
`mmap_anonymous`, and `release_host_region` unmaps nothing. Once the shared
mapping table is non-empty, teardown ordering between address-space release and
mapping release becomes load-bearing. **Not a defect today** — the table is
empty — which is exactly why it is written down now rather than discovered
later.

## A GATE I WROTE, WHICH ACCUSED THE WRONG LAYER (2026-09-11)

Recorded against my own work, because it is the fourth instance of one pattern
in a single session and the pattern is worth more than any of the four.

The sysroot postcondition added in `087a0c5b0` compiles a probe using
`opendir`/`readdir`/`closedir`. It writes `NULL` while including only
`<dirent.h>`. POSIX requires that header to declare `DIR` and those functions;
it does **not** require it to define `NULL`. So on a sysroot whose headers do
not supply `NULL` transitively, the probe fails and the script reports *"the
freshly built sysroot cannot compile a program that uses
opendir/readdir/closedir"* — **against a correct sysroot, blaming the sysroot.**

That is precisely the failure the postcondition exists to prevent. It blocked
`./run.sh setup` in every fresh worktree and was found by another agent, not by
me.

**The verification was the real defect.** I tested both directions and said so.
But the program I tested used `if (!p)` while the script emits `if (d == NULL)`
— **the version that shipped was never compiled.** Re-checked properly: on this
very sysroot, a translation unit including only `<dirent.h>` does not get
`NULL`, so it would have fired here too. The check passed because it exercised
a different source file.

### The four, together

| what was wrong | what it claimed |
|---|---|
| `vitest run host/test` from the repo root | 269 failures, ~89 in one file — all fiction |
| `scripts/xtask.sh` outside the dev shell | `abi/snapshot.json` may have drifted — nothing had |
| a `git add` that aborted on a stale pathspec | branch clean — HEAD carried a dangling import for hours |
| a probe verified with a different source than shipped | check works in both directions — one direction never ran |

**None announced itself.** Each returned a confident, specific, wrong answer,
and three of the four were mine. The defence is not more care at the moment of
checking — it is checking the artifact that ships: run the command the script
runs, read `HEAD` rather than the working tree, invoke the suite the way the
repository invokes it.

## THE HOST IMPORT FLOOR, STATED ONCE (current as of 2026-09-11)

**72 host functions, plus `env.memory`. A raw import-*entry* count therefore
reads 73.**

This heading exists because the number is quoted throughout this file at the
value it had when each entry was written -- 76, 75, 74, 73 -- and every one of
those rows is correct in its own context and wrong as a current figure. Four
agents have now been caught by the adjacent trap of reporting *entries* as
*functions*, and at least one report has been seen doing both at once: counting
73 entries as 73 functions and then adding `env.memory` on top.

Two rules, and they are cheap:

1. **Measure the built artifact**, never `EXPECTED_HOST_IMPORT_COUNT`. A pin that
   disagrees with the kernel is exactly what the gate exists to catch, and
   reporting the pin hides it.
2. **Say which you counted.** "72 functions" and "73 entries" are the same
   measurement; "73 functions" is a different and wrong one.

## LEDGER, 2026-09-11 — and why it moved the wrong way

Measured against the campaign merge-base with rename detection, in the format
the maintainer asked for: line delta and host surface, side by side.

| | |
|---|---|
| Production TypeScript (tests excluded) | **−3,137** |
| In-scope TypeScript including tests | **−4,057** |
| Rust | **+98,779** |
| Host imports | **72 functions + `env.memory`** (see below) |
| Host driver glue | ~9,900 lines |
| Commits since merge-base | 923 |

**Production TypeScript was −3,434 earlier in the night and is now −3,137.** It
moved the wrong way by ~300 lines, and the reason should be stated rather than
smoothed over:

- The V3 item **added +117** production lines. It was scoped to delete a
  subsystem and found that subsystem is live in production, so what it landed
  instead was a gate making silent image corruption unshippable. That is worth
  more than the lines it cost, but it is an addition and the ledger should say
  so.
- The per-process pointer width item reports **+30** production TypeScript and
  **+17** driver glue. It does not shrink anything. It was taken because it
  frees the `preadv2`/`pwritev2` `flags` slot before ABI 44 is finalised — after
  that, reclaiming the slot costs an epoch.
- B21's fixes were provisioning repairs, not deletions.

**This is the surface-aware ranking working as intended.** Three items in a row
scored badly on lines and were still the right work: one prevented silent
corruption, one bought an ABI slot that is about to become expensive, and one
made a build exit 0 with all eight images for the first time. The ledger is a
measure, not the goal, and the campaign has already been burned once by
optimising the measure — a 4,188-line TypeScript `ld.so` was deleted and a
3,666-line TypeScript dylink *driver* added in its place, which scored well and
moved V4 barely at all.

**W-1 is the first item on this branch that takes a host import away** (75 → 74)
rather than trading TypeScript for glue. That is the number to watch from here.

## ONE DELETION, FOUR REALMS — the night's largest finding

B21 was filed as "`gzip` and `xz` fail to build". It was none of the three
readings offered: those packages build green, the products *are* planned and
built by `setup`, and it was not the shared-cache race.

**The cause was this campaign's own `72fa12438`, "Delete the TypeScript
WebAssembly reader."** Every artifact read now goes through
`wasm_artifact_module32.wasm`, which must be *installed per realm* — and three
Node entry points were never given it:

1. a VFS image builder (`serializeImage` inspects every `.wasm` in an image);
2. a process worker running as a temp-dir esbuild bundle
   (`Could not find repo root` — this is what stopped `coreutils-docs`, a direct
   `shell` dependency);
3. `host/dist`'s own tsup build.

The third is a **loop**: `host-dist` had been failing since that commit, so
`host/dist` never existed, so every process worker took the temp-bundle path.

**A fourth realm was found independently the same night**: the Vite dev-server
realm, which made `./run.sh browser` die during dependency scanning with
`Binary exists but was not accepted: kernel.wasm` against a perfectly good
kernel — the reason several agents reported the browser as simply unreachable.

**The shape is the finding.** One deletion, four Node realms silently losing a
reader, each failing with a message about something else entirely: a package
that will not build, a repo root that cannot be found, a kernel that is not
accepted, a bundler that cannot resolve an alias. Per-realm initialisation with
no enforcement is the duplicated-authority pattern expressed as *"everyone must
remember"* rather than *"one place decides"*.

**Corrected premise:** this document previously recorded `./run.sh setup` as
"exiting 0 with products missing". It does not — a failed node makes the
aggregate `Failed` and `run_aggregate` returns `Err`. That observation cannot
have come from a completed run.

**Result:** `./run.sh setup` exits 0, zero failed or blocked nodes, all **eight**
VFS images. The five affected suites are 65/65.

## The actual conformance blocker, named at last

A **green** build's tier is still refused, and not for staleness. The check at
`host/src/binary-resolver.ts:~3330` compares two identities computed under
**different resolve policies**:

- the projection authority records `shell/wasm32 = 902b90ed…` under
  `ResolvePolicy::SourceOnlyV1`;
- `packages/registry/program-packages.json` records `d6ed5b85…` under
  `ResolvePolicy::Default`, hardcoded in `package_context_cache_keys`.

The `manifestSha256` halves agree. The policy halves cannot. **The equality can
never hold, so the refusal is unconditional** — which is why re-running `setup`
never clears it, and why `dash` and `coreutils` still resolve (they also live in
`~/.cache/kandelo/programs`) while `shell.vfs.zst`, `php` and `lamp.vfs.zst`
resolve nowhere.

Dispatched with the requirement that the two sides become **structurally
incapable of disagreeing**, not merely equal today.

## V3 — deferred with a measured split (D-B6)

The kernel writing the image is what unlocks removing `entries[]`, and it is
blocked on three independent gaps, none of them judgement calls:

1. **The kernel does not hold the bytes.** It has the tree and, since `KLZY`,
   the lazy table — but a base file's bytes live in the host's
   `MemoryFileSystem` and reach the kernel only through `host_blob_read`.
2. **There is no SFFS writer in Rust.** `sffs.rs` is 770 lines of *reader*; the
   image body is a real block filesystem — superblock, inode and block bitmaps,
   inode table, indirect pointers, directory index.
3. **Emission must stream.** `lamp.vfs` is 249 MiB; the kernel cannot buffer an
   image in linear memory.

Proposed split: **W-1** kernel serves image-backed bytes (retires
`host_blob_read` + `rootfs-blob-store.ts`, **import floor 75 → 74**) → **W-2**
Rust SFFS writer with a cross-language fixture → **W-3** streaming emission
(`rootfs::export_tree_read(offset, out)` is already the right cursor shape, no
new import) → **W-4** cut over, delete `rootfs-overlay-export.ts`, drop
`entries[]`. **W-1 is recommended next regardless of the rest.**

**Two findings that correct earlier framing:**

- **The host lazy materialization subsystem is LIVE**, with three non-test
  callers. The "~4,900 deletable lines" was wrong — it is not deletable today.
- **`entries[]` has exactly one load-bearing production reader**, and it is not
  fetching: after boot the host never consults it. The single reader is the
  restore→mutate→save round trip. That is precisely why moving the writer is the
  unlock.

**What did land:** the silent corruption is now impossible to ship.
`restoreParsedImage` re-derives `KLZY` from the JSON sections and requires byte
equality with the section the image carries. The check is **writer-agnostic**,
so it survives the move to a kernel writer rather than being replaced by it. The
existing save/restore/save gate would **not** have caught this — it used a
URL-backed lazy file, whose linkage the JSON carries directly.

### W-1 — DONE, 2026-09-11. Gap 1 is closed and the import floor is 74.

A base regular file now records WHERE its bytes are. `BaseSource::Image` means
"in the `/` image, at SFFS inode N", and the kernel reads them through the same
cursor `load_image` walked the tree with. `load_image` remembers the image's
SFFS span and the geometry `Sffs::mount` validated, so a later read
re-addresses the filesystem without re-parsing the container header. Host side,
the image window stays open past boot — re-pointed at the SFFS body the
restored `MemoryFileSystem` already holds, so no second copy of a 16-256 MiB
body is pinned.

**One correction to the split's own framing, found by doing it.** Serving
image-backed bytes from the image does NOT on its own empty `host_blob_read`.
Two callers survive it: a URL-backed lazy file is a base file the image
genuinely does not carry (`KLZY`, `archive_id == 0`, size only), and
`rootfs::load_manifest` — which `crates/host-native` still uses — places a base
tree the kernel never saw an image of. The brief expected one gap and there
were two.

What emptied the import was noticing its remaining meaning had become
`host_fetch_archive`'s: fetch a resource the image does not carry from a host
transport, serve positioned bytes, report `EAGAIN` while in flight. One
capability, two id namespaces, two imports. They are now
`env.host_fetch_deferred(kind, id, ...)` with `kind` an explicit argument, not
a reserved id range. **75 → 74**, verified against the built artifact's import
section.

`rootfs-blob-store.ts` is deleted (157 lines), and most of what went with it
was a boot-time walk of the ENTIRE `/` tree to build an inode-to-path map. The
surviving map covers only URL-backed lazy files (65 in the base image, 79 in a
derived one) and is read straight off the lazy table.

**The mutation window widened, and is now proven rather than inferred.** The
kernel used to read image bytes only during the boot walk; it now reads the
live `MemoryFileSystem` body for the session, and `sffs.rs` implements none of
`SharedFS`'s `Atomics` discipline (SD-B3). One half of the safety is structural
— a synchronous kernel entry cannot interleave with a same-thread host call.
The other half is tested: `host/test/rootfs-image-body-window.test.ts` pins
that materializing a URL-backed lazy file leaves every other file's bytes
byte-identical, read back through an INDEPENDENT mount of the mutated body.

**W-2 and W-3 are unblocked and unchanged.**

## OVERNIGHT STATE (2026-09-10, late) — read this first after a crash

**Maintainer directives in force:** push the ship line aggressively, including
the risky items; forward-only pushes to `brandonpayton/epoll-kernel-route`;
**never merge PR #1350**; curate only once the host suite is green.

### The ship line, and the criterion behind it

**ABI 44 becomes real when this ships.** Everything else is reversible in a
follow-up campaign; the ABI is not. So the test for "must land now" is *does it
change ABI 44's surface?* If yes, deferring costs a whole epoch.

| must land | why |
|---|---|
| B9 — per-process pointer width | frees the `preadv2`/`pwritev2` `flags` slot; ABI-affecting |
| V3 — remove image `entries[]` + move the image writer kernel-side | format + authority change |
| socket readiness | half-landed would make five disagreeing copies into six |
| local build / VFS products + the partial-build rule | gates conformance, T4 and the browser pass |
| B3 — mapping cutover | in flight |
| B4 — the measured 3.7× SysV regression | shipping a known measured regression contradicts the performance contract |
| T3/T4 — host suite green | the gate itself |

**Clean to defer** (no ABI surface, no half-state): B2, B8, B10, NDD-K4-3,
NDD-K11-1, NDD-K11-3, and the ~9,900-line driver-glue audit that is campaign
two's charter.

### Agents in flight

| item | touches |
|---|---|
| local build / VFS products + partial-build rule | `tools/xtask/src/local_build.rs`, package builds |
| socket readiness (five disagreeing copies) | `crates/runtime-core/src/syscalls.rs`, four host backends |
| B9 per-process pointer width | `registerProcess`, `kernel-worker.ts`, `process-lifecycle.ts`, `process.rs` |
| V3 image writer | `memory-fs.ts`, `rootfs-overlay-export.ts`, `rootfs.rs` |
| B3 mapping cutover | the `MemoryManager` first-fit allocator |

**Check every agent's `git merge-base` before merging or believing a number.**
Three worktrees today arrived on `9195dedd1`, ~885 commits behind, and produced
results that were internally consistent and about the wrong tree.

### V3's scope grew, correctly, on a maintainer question

The first scoping said step 5 could not land: removing `entries[]` would
silently corrupt images, and an earlier report called `entries[]` and `KLZY`
"two encodings of one structure".

**That framing was wrong.** `host/src/vfs/kernel-lazy-section.ts` documents a
deliberate split *by authority*: the JSON carries fetch URLs, transports,
integrity digests, activation modes and seals — "all of that is HOST authority"
— while `KLZY` carries the only two kernel-relevant facts.

Measured field by field, a `LazyFileEntry` is
`{ ino, generation, dataSequence, path, paths[], url, size }`:

- `ino`, `size` — already in `KLZY`;
- `generation`, `dataSequence` — already in the SAB image's inode identity;
- `path`, `paths[]` — derivable by walking the restored tree (must be *proved*
  per entry, per SD-B5, with a fallback);
- **`url` — genuinely unique, and it is not data but authority.**

So `entries[]` is overwhelmingly redundant, and what remains is a statement
about who owns fetch policy. The maintainer then asked the question that
settles the shape: *doesn't this mean `rootfs-overlay-export.ts` moves to Rust
too?* Yes — and it is what removal **unlocks**, not a cost of it. That module's
own header says it clones the base image precisely because the lazy descriptors
"live only in the base image", and it already asks the kernel to serialize its
authoritative tree via `kernel_rootfs_export_tree` (RXPT,
`crates/runtime-core/src/rootfs.rs`). The kernel already owns `/` and can
already serialize it; the host's clone-diff-reserialize dance exists **only**
because the lazy table sits on the other side of the split. Move it and the
kernel can write the image directly — V3 stated plainly.

**The hazard to design out, not guard:** restore→mutate→save runs in production
(`rootfs-overlay-export.ts:225`, `:316`, from `process-lifecycle.ts:1800`). A
save that cannot rebuild the lazy table emits a `KLZY` with an empty file table
and every archive-backed lazy file becomes a silent 0-byte regular file.
`host/test/vfs-image-kernel-lazy.test.ts:374` is the existing gate; it passes
today and must keep passing. The documented lossy boundary must survive too:
runtime-created AF_UNIX sockets and FIFOs are reported as `skippedSpecial`,
never fabricated.

## MERGE ORDER FOR THE SIX IN-FLIGHT AGENTS (planned 2026-09-10)

Written before anything lands, because the maintainer's instruction was
explicit: *"Please don't make different campaign tier work clobber each other.
Let's thoughtfully merge."* Both of this campaign's design collisions landed in
shared foundation files, never in the leaf files agents were assigned, so the
overlaps are known in advance here rather than discovered at merge time.

### Measured overlap

| file | agents touching it |
|---|---|
| `crates/runtime-core/src/syscalls.rs` | epoll, slot placement, K11 — **three-way** |
| `crates/kernel/src/wasm_api.rs` | epoll, slot placement |
| `abi/snapshot.json` | epoll, slot placement (both regenerate) |
| `crates/runtime-core/src/process.rs` | slot placement, K11 |
| `crates/host-native/src/lib.rs` | resolver, slot placement |
| `host/src/generated/abi.ts` | epoll (regenerated) |

### Order, and why

1. **Resolver / one-location artifacts** — smallest footprint (4 files) and it
   unblocks ~167 of the 212 test failures. Nothing downstream can be measured
   honestly until it lands. Collides only with slot placement, on
   `crates/host-native/src/lib.rs`.
2. **Epoll host-mirror deletion** — large but concentrated in its own area
   (`kernel-scratch`, `wasm_api`, `syscalls`).
3. **pthread slot placement** — overlaps epoll on `wasm_api.rs`, `syscalls.rs`
   and the snapshot. Merge after epoll so the snapshot is regenerated once, on
   top of both, rather than twice against each other.
4. **K11 devices** — overlaps on `syscalls.rs` and `process.rs`; last, so it
   rebases onto a settled kernel surface.
5. **T2 (`browser-kernel.test.ts`)** and **T3 (VFS products)** — independent
   file sets, mergeable whenever they finish.

**After the Rust four land: regenerate `abi/snapshot.json` once**, then
`./scripts/xtask.sh verify-fresh` and the full host suite. Do not accept either
agent's snapshot as-is; two regenerations of the same file against different
bases is precisely how a snapshot ends up describing neither tree.

### The dispatch defect to fix in how agents are launched

**Twice now an agent has been given a worktree based on `9195dedd1`, the
campaign merge-base, instead of the branch tip** — once the resolver agent
(after being resumed from a stall), once the B21 agent, dispatched in the same
message as a sibling that got the correct tip. Both were caught by checking
`git merge-base` against each worktree's HEAD before trusting their work.

The cost is real: the resolver agent had written a fix against a 3,041-line
`constants.ts` that is now 294 lines, and had re-fixed an asyncify check that
was already fixed. **Check every agent's base before merging, and before
believing any measurement it reports.** A worktree on the wrong base produces
results that are internally consistent and about the wrong tree.

## THE TEST-FAILURE PLAN (maintainer-directed 2026-09-10)

**"Please go ahead and plan to fix these tests as part of this campaign."**
So the pre-existing failures are in scope, not just the ones this campaign
caused. The ship gate is a green host suite, not a green *delta*.

### The measurement that this plan rests on, and the hypothesis it killed

Two full runs, both correct (from `host/`, inside `scripts/dev-shell.sh`):

| kernel | result |
|---|---|
| stale (`verify-fresh` complaining) | 213 failed / 3,946 |
| freshly built **and** properly installed, `verify-fresh` exit 0 | **212 failed / 3,946** |

**One test.** The rebuild changed essentially nothing, which disproves the
attribution written earlier in this document — that the 81
`void kernel ingress kernel initialization completion failed` errors were
kernel staleness. They are not. They are downstream of the *same* artifact
closure refusal as the 42 explicit `Package artifact closure is incomplete`
errors: a worker that cannot resolve its artifacts cannot initialise a kernel,
whatever the kernel's age.

Recorded because it was my hypothesis, it was specific, it was wrong, and the
only reason it did not become an accepted fact is that the re-run was done
instead of assumed.

### The four roots, and who owns each

| # | root | failures | owner |
|---|---|---|---|
| T1 | artifact tier identity — closure refused, kernel init fails, timeouts cascade | ~167 | B19/B23 agent |
| T2 | `browser-kernel.test.ts` — one `?url` stub for every alias | ~60 | dispatched 2026-09-10 |
| T3 | missing VFS image products (`shell`, `nginx-vfs`, `node-vfs`, `lamp`, `nginx-php-vfs`) and `examples/mqueue_test.wasm` | ~13 | dispatched 2026-09-10 (B21) |
| T4 | residue — 7 `vi.fn` never called, 5 `unreachable`, assorted | ~20 | **after T1–T3 land**, because most should vanish with them |

T4 is deliberately not dispatched. Most of that residue sits in suites whose
kernel never initialised, so triaging it now would be triaging cascades.

### T3's brief carries a disagreement on purpose

B21 was reported as "`gzip` and `xz` fail to build". In the coordinator's
worktree, after a `./run.sh setup` that exited 0, `gzip.wasm`, `xz.wasm`,
`nginx.wasm`, `php` and `dash.wasm` are all present — and gzip/xz are dated
*before* the run that reported them failing. Three readings survive: the build
really fails and those are stale leftovers; the build works and the *products*
are simply never built by `setup`; or it is the shared build-cache race, whose
isolation flag `nix develop --ignore-environment` silently strips. The agent
was told to decide which before fixing anything, because the three have
different fixes and "did not reproduce in one worktree" is weaker evidence than
a failure someone watched happen in another.

### Host suite triage, measured 2026-09-10 — what is ours and what is not

Run correctly (from `host/`, inside `scripts/dev-shell.sh`) against a kernel
that `verify-fresh` still called stale:

    Test Files  101 failed | 320 passed | 6 skipped (427)
         Tests  213 failed | 3706 passed | 2 expected fail | 25 skipped (3946)

Clustered by cause, not by file:

| count | cause | whose |
|---|---|---|
| 81 | `void kernel ingress kernel initialization completion failed` | stale kernel / tier |
| 47 | test timeouts | downstream of the above |
| 42 | `Package artifact closure is incomplete` | **B19**, verbatim |
| 30 | `BrowserKernel test should not fetch` | **pre-existing on main** |
| 30 | test doubles undefined (`simulateMessage`, `lastMessage`, `sent`) | same file as above |
| 3 | `expected 'stub://vite-url' to be 'stub://default-rootfs'` | **pre-existing on main** |

**The `browser-kernel.test.ts` family (~60 failures) is not ours.** Verified
rather than assumed: `host/test/browser-kernel.test.ts`,
`host/test/fixtures/vite-url-stub.ts` and
`host/src/browser-kernel-default-artifacts.ts` are **byte-identical to
`origin/main`**, and the campaign's only edit to `host/vitest.config.ts` was
adding `setupFiles`. The mechanism is structural: the config's
`vitest-stub-vite-url-imports` plugin resolves *every* `?url` import to one
fixture exporting `"stub://vite-url"`, while the test asserts `fetch` is called
with `"stub://default-rootfs"`. `browser-kernel-default-artifacts.ts` obtains
that URL from `@rootfs-vfs?url`, so the assertion cannot match under any
kernel. A per-alias stub would fix it; that is main's bug to fix, logged here
so nobody spends the campaign's time on it.

**Everything else in the table is one of two roots** — the stale kernel and the
tier-identity refusal — which is why the re-run against a freshly built and
properly installed kernel is the measurement that matters, not this one.

### `bootstrap kernel` updates one tier and leaves the other stale

The cleanest demonstration of B23 yet, produced while clearing the gate:

    ./scripts/xtask.sh bootstrap kernel      # publishes source-only-v1
    ./scripts/xtask.sh verify-fresh
    -> local-binaries/kernel.wasm is stale: built for key 925962d2...,
       current source tree resolves to key e5d75599...

One build command, one tier updated, the other left behind — and `verify-fresh`
names it exactly. `install_local_binary kernel <fresh>` then repaired it, which
it could only do once the asyncify guard stopped refusing the artifact. Both
halves of the loop had to be fixed before a green gate was reachable at all.

### Another wrong invocation, another confident wrong answer

`verify-fresh` reported "the ABI-snapshot freshness check did not pass (either
`abi/snapshot.json` drifted from its sources, or the check could not run)".
Nothing had drifted. The real line was
`scripts/check-sysv-ipc-layouts.sh: line 18: wasm32posix-cc: command not found`
— `scripts/xtask.sh` ran `cargo run` directly rather than through the dev
shell, so the SDK was absent and a sub-check could not run. Following the
message's own advice would have produced a no-op snapshot regeneration commit.

Fixed: the wrapper now re-execs through `scripts/dev-shell.sh`. But note the
family. Three separate wrong invocations in one day each produced a confident,
specific, entirely wrong result: vitest from the wrong directory (269 fictional
failures), vitest outside the dev shell (~80, earlier in the campaign), and
xtask outside it (fictional ABI drift). **The check being right is not enough;
the invocation has to be right, and a wrong one does not announce itself.**

### Trap: `vitest run host/test` from the repo root is not the host suite

Measured 2026-09-10 and recorded before it costs anyone else a day. Running
`npx vitest run host/test` from the repository root reported **269 failed of
3,447**, including ~89 failures in `browser-kernel.test.ts` alone
(`Cannot find package '@fork-module32-wasm?url'`, `simulateMessage` undefined).

None of those were real. `host/vitest.config.ts` carries a plugin,
`vitest-stub-vite-url-imports`, that stubs `?url` and `?worker&url` imports so
browser-origin modules load without a Vite environment. Invoking vitest from
the repo root never loads that config, so every Vite-aliased import fails.

**Run it as the repo does: from `host/`.** This is the same family as the
earlier trap where a full Vitest run outside `scripts/dev-shell.sh` produced
about eighty bogus failures — a wrong invocation that produces confident,
specific, entirely fictional results.

### B. The register — current state, 2026-09-11

Rewritten, not appended to. Earlier revisions carried B5 and B6 twice and eight
stale statuses, because agent doc-merges append and this table is what decides
what gets dispatched. **One row per item. Closed rows stay so nobody re-opens
them.**

| # | Item | State |
|---|---|---|
| B1 | K1 step 5 — image `entries[]` + ABI stamp | **Superseded by D-B6.** Maintainer chose the full subsystem removal; scoping proved it needs the kernel to write the image. Split into W-1…W-4 |
| B2 | K7 — shared-mapping coherence + mapping cutover | **Merged with B3 into one item.** Opening move and policy layer landed; handle retention landed 2026-09-11, so the cutover's remaining prerequisite is gone. Needs `syscalls.rs`, held while B8 has it |
| B3 | *(folded into B2)* | B3 alone failed twice; anon and file share one container across 15 interleaved sites |
| B4 | The measured 3.7x SysV regression | **IN SCOPE for #1350** (maintainer, 2026-09-11). Lane A, after B2+B3: the zero-import remedy is to hoist destination validation *before* the source view, and it lives in `syscalls.rs`, which B2+B3 is rewriting. `host_proc_read_bytes`'s second copy narrows a grow-detach window and must stay |
| B5 | K11 device pieces | **CLOSED.** Piece 3 cut over (TS −100 / Rust +626); pieces 2 and 4 immovable for named reasons; a dead Node TLS backend deleted (−3,556) |
| B6 | K3 epoll cutover | **CLOSED.** Host mirror deleted; census found 17 touchpoints where the grounding listed 14 |
| B7 | epoll fork inheritance + OFD keying | **CLOSED.** Unit-tested, explicitly not conformance-validated |
| B8 | K3 wait-queue cutover | **IN FLIGHT.** Maintainer: "done in Rust unless there is a good reason not to — wiring that still needs doing". Fixes wall-clock deadlines; may close `epoll_pwait`'s ignored signal mask |
| B9 | Per-process pointer width | **CLOSED.** Frees the `preadv2`/`pwritev2` `flags` slot before ABI 44 finalises. Found twelve dispatch arms reading a bare `args[5]` |
| B10 | Kernel-owned shebang parsing | **IN SCOPE for #1350** (maintainer, 2026-09-11). Lane F, design-first: blocked on a prepared-target token the side-effect-free spawn preflight cannot obtain, so the design is the work, not the typing |
| B11 | `report_writeback_loss` wiring | **CLOSED 2026-09-11.** `host_debug_log` removed; host imports **73 → 72**, measured from the artifact. The loss is kernel state at `/proc/kandelo/writeback_losses`, reached through an existing export, so no ABI export surface was added to retire an import. Later generalized with an explicit kind when a second lane added a handle-loss caller |
| B12 | `privileged-projection.ts` | **CLOSED.** Deleted, −1,418, on the finding that it duplicated a live route |
| B13 | `dylink-planner.ts` | **CLOSED.** Production, not deletion debt |
| B14 | SysV IPC conformance coverage | **IN SCOPE for #1350** (maintainer, 2026-09-11). Lane E, after the 46-failure triage. None exists anywhere in `tests/` -- this is a coverage gap, not a known defect: nobody can say what SysV IPC gets wrong because nothing asks |
| B15 | TLS `SharedArrayBuffer` hazard | **CLOSED.** Boundary copy; the nine typecheck errors *were* the reachable sites |
| B16 | Typecheck baseline | **CLOSED.** 0, and held all night |
| B17 | `tar/wasm32` | **CLOSED.** A broken sysroot wearing a package's clothes |
| B18 | `setup` root npm | **CLOSED** |
| B19 | Local artifact tier refused | **CLOSED 2026-09-11.** Not staleness: the check compared a `SourceOnlyV1` key against a `Default`-policy one, so it differed **by construction — 0 of 70 packages could ever match**. Fixed by recording the selection index the build was materialized from, through one shared entry point |
| B20 | Tier-end browser pass | **IN SCOPE, lane H (the singleton lane).** The Vite dev-server realm no longer needs its own install (B25). The Playwright *worker* realm remains: 14 specs call `resolveBinary` directly. A clean package build plus manual demo verification has not completed -- the first attempt died on a torn tree caused by a cherry-pick racing the build's read |
| B21 | Missing VFS products | **CLOSED.** Never `gzip`/`xz`: three Node entry points lost the artifact reader when the TypeScript WebAssembly reader was deleted. `setup` exits 0 with all eight images |
| B22 | libc-test unfetchable | **CLOSED.** Never a repo defect — a stale ssh URL in `.git/config` plus a renamed `.git`, both local |
| B23 | Two consumers, two tier orders | **CLOSED** with B19 |
| B25 | Per-realm artifact reader | **CLOSED 2026-09-11.** Installation is now a property of RESOLUTION: the driver side-imports `#wasm-artifact-module-source`, whose package conditions select a Node loader or a browser no-op. Nine install sites → two, and the two that remain are the browser's, which cannot be synchronous. Also fixed a boot-blocking bug for installed consumers and deleted the duplicated tier list. Proven under Vitest: `binary-resolver.test.ts` 85/85 with `setup: 0ms` |
| B29 | A stale kernel artifact fails as "the kernel is broken" | **IN SCOPE for #1350** (maintainer, 2026-09-11). Lane D. `host-native` loads `source-only-v1/kernel.wasm`; after a rebase without re-staging, 41 tests fail with `failed to find function export …`. The message names the symptom and hides the cause. Diagnostics, but it has already cost agent-hours, and this campaign's most expensive hours have all gone to confident wrong answers |
| B30 | A reaped build publishes an authority for a build that never finished | **IN SCOPE for #1350** (maintainer, 2026-09-11). Lane D, with B29 -- same subsystem, and splitting them puts two agents in `local_build.rs` |
| B31 | Tuning constants whose evidence predates the link-contract fix | **IN SCOPE for #1350** (maintainer, 2026-09-11). Lane B, after the select fold-in, since the constant lives in the code that rewrites. Twelve repetitions bound 0 ms as insufficient (11/12) and 50 ms as sufficient (12/12); they do **not** show 50 is minimal |
| B32 | Case-collapsed conformance checkout | **CLOSED 2026-09-11**, and the filed premise was wrong. The 17 files are not mis-testing: the surviving entry is the lowercase spelling with its own correct content, and the uppercase tests are **never run** -- `include` reports 3,741 tests collapsed vs 3,758 case-sensitive, silently. Guard demonstrated firing across six states; measured cost is inside the run-to-run spread |
| B33 | `ppoll` EINTR semantics | **CLOSED 2026-09-11.** One case label removed from `kandelo_should_restart_after_handler`, which listed `__NR_ppoll` while omitting `__NR_pselect6`. `poll`, `select`/`pselect6` and `epoll_wait` already agreed. Signal suite 32 PASS / 0 FAIL, and the racy seven-case set run 12x at 12/12 |
| T4 | Test residue | **IN SCOPE for #1350** (maintainer, 2026-09-11). Lane G, after T1–T3: ~20 items -- 7 `vi.fn` stubs never called, 5 unreachable branches, assorted. Most should vanish with T1–T3 rather than be fixed |
| W-2 | Rust SFFS writer + cross-language fixture | **IN SCOPE for #1350** (maintainer, 2026-09-11). Lane C, first link and the campaign's longest single item: `sffs.rs` is 770 lines of *reader*, and the image body is a real block filesystem -- superblock, inode and block bitmaps, inode table, indirect pointers, directory index |
| W-3 | Streaming emission | **IN SCOPE for #1350.** Lane C, after W-2. `lamp.vfs` is 249 MiB, so the kernel cannot buffer an image in linear memory; `rootfs::export_tree_read(offset, out)` is already the right cursor shape and needs no new import |
| W-4 | Cut over, delete `rootfs-overlay-export.ts`, drop `entries[]` | **IN SCOPE for #1350.** Lane C, last. Note the silent-corruption risk that made this urgent is already closed: `restoreParsedImage` re-derives `KLZY` from the JSON sections and requires byte equality, and that check is writer-agnostic, so it survives the move rather than being replaced by it |

### B25 — the per-realm artifact reader, and a decision I stopped short of making

**The problem.** Resolution reads every candidate artifact through the
wasm-artifact module, and that reader must be installed **once per realm**.
Every Node entry point has to remember: `worker-entry.ts`,
`node-kernel-host.ts`, `node-kernel-worker-entry.ts`, and — added tonight —
`apps/browser-demos/vite.config.ts`.

**Four realms forgot**, and each failed with a message about something else: a
package that would not build, a repo root that could not be found, a kernel
"not accepted", a bundler that could not resolve an alias. A fifth is open: the
**Playwright worker process**, where fourteen spec files call `resolveBinary`
directly and share no helper module to hold an installation.

"Everyone must remember" has no failure mode that names itself. That is the
whole defect.

**The obvious fix, attempted and reverted.** `binary-resolver.ts` is Node-only
(`node:crypto`, `node:child_process`, `node:fs`) and is the single door every
resolution passes through, so installing the reader there — once, lazily —
removes the class of bug outright. Two things were learned attempting it, both
worth keeping:

1. **A module-scope install does not work under Vitest.**
   `wasm-artifact-module-node` imports `resolverRepoRoot` from
   `binary-resolver`, so the two are mutually dependent. Native ESM tolerates it
   (both are hoisted function declarations), but Vitest's SSR transform rewrites
   imports into bindings that are not, and the suite refuses to collect with
   `Cannot access '__vite_ssr_import_N__' before initialization`. A **lazy** call
   from inside the resolve entry points has no such problem, because both
   modules have finished evaluating by the time anything resolves a binary.
   Measured, not reasoned about.

2. **It collides with a deliberate diagnostic.** `binary-resolver.test.ts` pins
   the message *"has not been installed in this realm"* — a test written so that
   a missing reader is loud rather than mysterious. Auto-installing makes that
   diagnostic unreachable from this path.

**Stopped there on purpose.** Making the change pass required editing that
assertion, and editing a guard so a change looks right is the failure mode this
campaign has caught ten times in other people's code. The question is genuinely
the maintainer's:

- if the reader can always be installed under Node, the "not installed"
  diagnostic is only reachable from a browser realm, and the test should say so;
- or the diagnostic is worth keeping reachable, and the five realms should each
  install explicitly, with something that fails when a sixth forgets.

Either way **the enforcement matters more than the fix**: a per-realm
initialisation contract with no check is what produced four unrelated-looking
bugs from one deletion.

### B26 — CLOSED. The exit-144 kills are not the test suite

**This entry was written wrong twice, with two different confident causes, and
the corrections are the useful part.**

- *First version:* "the host suite cannot reliably finish, and it is the ship
  gate" — three runs killed, framed as a coin flip.
- *Second version:* cause identified as cross-agent contention, on the strength
  of nine concurrent vitest processes.
- **Both wrong.**

**The decisive observation.** Two of the tasks that exited 144 contained **no
Vitest, no Node, no Nix and no Wasm**. They were pure Bash:

    until grep -aq "Test Files" "$F"; do sleep 20; done

Both produced **zero bytes of output** and both ended `[exited with code 144]`.
A Vitest pool watchdog, a Node OOM, a Nix failure, memory pressure and
cross-agent contention are *all* excluded by that one fact: none of them can
reach an idle `sleep` loop. The coordinator's own waiter task died the same way
and was read as the suite failing.

Supporting measurements taken while kills were happening: **73% memory free**,
703 user processes against a `kern.maxprocperuid` of 8000, fd limit 1048576.
Nothing near exhaustion. The kills cluster in *time*, not at a threshold — and
the two runs that completed each ran about half an hour, so it is not a lifetime
cap either.

**It is a background-task termination in the agent harness**, and nothing in the
repository can observe the trigger. That is recorded as an unknown rather than
dressed up, precisely because every plausible story is one the evidence rules
out.

### What this actually means for the gate

**Every run that was not externally killed, finished.** Two produced complete
results (~24 minutes of test time each). A third died in global setup from a
diagnosed, reproducible cause:
`cargo run -p xtask -- build-deps program-index` is **not safe against a
concurrent `cargo` in the same checkout**. The suite never once failed to
complete on its own merits.

So the operational guidance is small, and the ship gate is intact:

1. **Nothing else may touch `cargo` while the suite runs.** That killed one of
   six attempts, and it is the only self-inflicted failure in the set.
2. **An exit 144 carries no test information.** Do not read it as a failure;
   re-run.
3. **Budget ~25 minutes**, plus fixture builds in a cold worktree.

A gate that occasionally needs a retry is a far smaller problem than a gate that
cannot complete. The evidence says this is the former.

**The coordination rule from the second version is withdrawn as a diagnosis but
kept as hygiene:** concurrent full suites still contend for the cargo lock, and
the coordinator produced two false failures tonight by ignoring that — an
`xtask` byte-identity test that passes 2/2 in isolation, and a `./run.sh setup`
writing into a live agent's cache root. Serialise full runs because of the cargo
rule above, not because of 144.

### One detail the attribution method must not lose

What made the controlled baseline work was staging **each side's own kernel**.
Reusing one branch's `kernel.wasm` against the other's host code manufactures
failures — that kernel exports `kernel_set_process_pointer_width` and no longer
stamps slot 5 — and produces a confident, wrong attribution. That is the step
most likely to be skipped by whoever applies the method next.

### B19's fix, proven end to end — and a vacuous suite found on the way

**Proof, in a freshly built worktree under the default policy:**

    OK  programs/wasm32/dash.wasm         -> [source-only-v1]
    OK  programs/wasm32/shell.vfs.zst     -> [source-only-v1]
    OK  programs/wasm32/lamp.vfs.zst      -> [source-only-v1]
    OK  programs/wasm32/php/php.wasm      -> [source-only-v1]   (9-member closure)
    OK  programs/wasm32/wordpress.vfs.zst -> [source-only-v1]
    OK  kernel.wasm                       -> [source-only-v1]

Before the change, **0 of 70** packages could satisfy the check. The `php`
closure is the multi-package product the whole defect was hiding behind — nine
members (`php.wasm`, `php-fpm.wasm`, `opcache.so`, `curl.so`, `phar.so`,
`zend_test.so`, `zip.so`, `intl.so`, `icu.dat`). And `./run.sh setup` produced
all **eight** VFS images, which the image builder can only do by resolving those
closures.

Invariant on the real build: `recorded selection == regenerated index` **70/70**,
and `tier(SourceOnlyV1) cacheKeys != index` **70/70** — the two stay
deliberately non-comparable, so a future swap fails at that assertion rather
than in a conformance run.

**The scare that validated the design.** A first check showed 7 of 70
disagreeing — `shell`, `lamp`, `wordpress` and everything depending on `shell`.
The cause was self-inflicted: `shell`'s declared build inputs include
`host/src/binary-resolver.ts`, which had been briefly reverted to demonstrate a
pre-existing test failure, and the on-disk index was written during that window
while the authority was published after it. Regenerating the index took it to
70/70. **That is the drift detector working on a real input change** — and,
unlike the check it replaced, it was *satisfiable*.

### A suite that ran zero tests and reported success

Found while clearing the way to conformance: in a fresh worktree the `os-test`
submodule is uninitialized, so the Sortix suite reported **`Discovered 0 tests`**
for `include` and `limits` and passed **vacuously**. After
`git submodule update --init` it discovers **3,741**.

That is the same failure shape as the defect that agent was sent to fix, and the
eleventh-plus instance of this campaign's most common finding: *a check that
cannot run, reporting as a check that passed.* Conformance provisioning must
verify the submodule is populated, not merely that the runner exited 0.

### B27 — three gaps B24 surfaced, none of them bundled

**B27a — the native host never registers a pointer width. DONE 2026-09-11.**
The TypeScript host treats `kernel_set_process_pointer_width` as required;
`crates/host-native` never called it. It worked **only because
`Process::pointer_width` defaults to 4** — *a lucky default, not a
registration*. A wasm64 guest on the native host would therefore be told it is
wasm32 by a default nobody chose. Closed alongside the wasm64 arm below; see
the combined section under B24.

**B27b — the wasm64 arm of the record-syscall coverage. DONE 2026-09-11.**
`crates/host-native/fixtures/build-fixtures.sh` targeted
`wasm32-unknown-unknown` only. The wasm32 fixture catches the regression that
actually happened (a width read as **0**) but **not** one that only manifests at
width **8** — the likelier future regression, since wasm64 has no guests in
daily use. Both process-layout tests now run at widths 4 and 8; see the
combined section under B24.

**B27c — `setitimer`/`getitimer` values are uncovered, and honestly so.** The
fixture exercises their *marshalling* via `ITIMER_VIRTUAL`, but not a value
round-trip, which needs `ITIMER_REAL` and therefore `host_set_alarm` — an import
the native host deliberately traps. The agent declined to add a host stub that
accepted the call and never delivered, on the grounds that it would be the
dishonest kind of stub. That is the right call under the platform-values
contract, and the gap is recorded rather than papered over.

### B27a + B27b — DONE 2026-09-11. The registration and the arm that sees it

Split out of B24 deliberately, and done together because **neither is
observable without the other**. Registering a width on a host that only runs
wasm32 guests writes the value the default already held; running a wasm64 guest
on a host that registers nothing gets the default. Each is the other's only
witness.

**B27a.** `ProcessLayout` now carries `pointer_width`, derived where the rest
of the layout is derived, through `wasm_artifact::detect_pointer_width` — the
one authority, the same function `detectPtrWidth` is on the TypeScript hosts
and the same one `exec_target::finish_commit` calls. `launch_process` and
`launch_vfork_borrowed_child` register it beside the brk/mmap/max-addr
sequence; the export is bound with `get_typed_func`, so a kernel lacking it
fails the run rather than falling back. An exec re-launch deliberately does
**not** re-register, mirroring the TypeScript host's `replacingExecImage`
guard for the reason stated there; a fork child does, because it is a fresh
address space this host just created from bytes it just read.

**B27b.** `build-fixtures.sh` builds a declared `WASM64_FIXTURES` list at
wasm64 as well, from one compile/link helper parameterised only by target and
sysroot. Both process-layout tests loop over widths 4 and 8, and the
descriptor-derived coverage requirement now holds **at each width
independently** — a descriptor covered only at wasm32 is one whose wasm64 size
nothing has exercised.

**The expected output block is identical at both widths, and that is the
point.** Every value in it is a kernel constant or a value the guest supplied
earlier in the same run, so none depends on pointer size. What depends on
pointer size is how many bytes each record occupies, so a disagreement about
that surfaces as a changed *value*, never as a changed expectation.

**Five wasm32 assumptions the type system was not checking.** Making the native
host able to instantiate a wasm64 guest at all needed: `Config::wasm_memory64`;
`new_shared` building the memory in the importing module's index type (and a
fork child's copy inheriting the parent's); `env.__channel_base` supplied as
`i64`; and `kernel_argv_read`/`kernel_environ_get`/`kernel_execve` declared
with an `i64` pointer parameter. Wasmtime matches import types exactly, so each
was an instantiation error rather than a silent coercion — which is why they
surfaced one at a time rather than as wrong behaviour.

**The guard was seen to fail.** Building a host that registers width 4 for
every process — this host's state before B27a — makes the wasm64 arm stop at
**exit code 4 on `statfs`**, the first record, because the kernel then parses an
LP64 record at ILP32 offsets; the descriptor-derived test additionally names all
twelve syscalls left uncovered at width 8. **The wasm32 arm stays green
throughout**, which is the entire argument for the second arm.

**What it does NOT cover, measured rather than assumed.** Forcing `marshal_in`
to pick `wasm32_size` for every caller leaves **both** arms green. Only three of
the thirteen keep RAW arguments, and all three share `rt_sigqueueinfo`'s
`siginfo_t`, which is **128 bytes at both data models**; the other ten ride the
opaque-record path where the guest glue sizes its own spans. So the host
marshaller's width selection is correct by construction here, not covered — the
same shape as B24's retracted canary claim. The wasm64 widening of guest
pointer arguments is likewise unexercised: this host caps guest memory below
4 GiB, so no address it stages differs between the two masks.

**One incidental finding, not acted on.** Re-running `build-fixtures.sh` today
regenerates **22 of the 23** wasm32 fixtures with different bytes than the
committed ones (`native_hello.wasm` 17493 → 15657). `native_process_layout.wasm`
reproduces byte-for-byte, which is consistent with it being the only one built
since the current libc. The committed fixtures still pass their ABI marker check
and their tests, so this is staleness relative to today's libc rather than a
defect; the 22 rebuilds were reverted as out of scope.

### What B24 proved about the hole it was sent to close

The plan was right about the design and wrong about four premises, and the
corrections are worth more than the fixture:

1. **Thirteen syscalls, not twelve.** Deriving the set from
   `SYSCALL_ARG_DESCRIPTORS` immediately turned up `waitid` and `mq_notify`,
   both absent from the hand-list. **The derivation earned its keep on its first
   run** — which is exactly the argument for requiring it.
2. **The native host had no `ProcessLayout` case at all.** `marshal_in` in
   `crates/host-native/src/guest.rs` bailed with `unsupported arg size`, so all
   thirteen were **unreachable** on the one host that runs the real
   `kernel.wasm` with real guests. The hole was not "untested"; the path did not
   work. Fixed in 15 lines mirroring the TS host.
3. **Only three of the thirteen are RAW.** The other ten ride the opaque-record
   path where guest glue sizes its own spans and the host is out of the data
   path — so the agreement protected is host↔kernel for three, and
   guest-glue↔kernel for ten.
4. **`waitid` has no Rust dispatch arm** and returns ENOSYS. The fixture asserts
   that ENOSYS rather than skipping, so when `waitid` moves into the kernel the
   assertion fails and forces real coverage.

**The guard was proved three ways**, including building a kernel whose
`current_caller_pointer_width` reports 8 for a wasm32 caller — the actual
regression class — and watching `statfs` fail at exit code 4.

**And a claim was retracted mid-item.** The first commit said the fixture's
canaries catch a wrong-width record. They do not: nine of the ten record-path
syscalls never have a host-sized span copied into guest memory, and the two RAW
ones are 128 bytes at *both* models. It was caught by forcing the marshaller to
`wasm64_size` and finding the suite still green — the **content assertions** are
what catch a width error. The canary remains as an honest guard on RAW copy-back
extent, with the header corrected to say so.

### THE TIP MEASUREMENT (2026-09-11) — and why the headline number misleads

First full host suite run at the campaign tip:

| | base `0ab2ccf3e` | tip | change |
|---|---|---|---|
| Failed | 103 | **112** | +9 |
| Passed | 259 | **311** | +52 |
| **Skipped** | **65** | **4** | **−61** |
| | 427 files | 427 files | |

**Read the skip column first.** Sixty-one files that previously skipped now
actually run; fifty-two of them pass and nine fail. The artifact and realm fixes
did not make the suite worse — they converted silent skips into real executions.
For a campaign whose most common finding is *a check that could not run
reporting as a check that passed*, that is the intended direction, and a rising
failure count is the honest cost of it.

**And the remaining 112 is a provisioning number, not a code number.** The
largest cluster — 38 × `Package artifact closure is incomplete` — is this
worktree's own stale tier, and the resolver says so exactly:

    Invalid source-only projection authority …: the tier was published before
    the build recorded the package selection it was built from, so its identity
    cannot be checked; rebuild it with ./run.sh setup

The authority here was written at 00:38, before the tier-identity fix landed.
**That message is itself the improvement**: the same condition previously
reported `programs/wasm32/dash.wasm (missing)` about a file sitting in the tree,
which sent several agents to rebuild the wrong thing for hours. It now names the
real cause and the exact remedy.

The better evidence for the fix is the fresh-worktree proof recorded above —
70/70 resolving, `php`'s nine-member closure among them, all eight VFS images
built. A tip measurement taken against a pre-fix tier measures the tier, not the
branch.

**Clusters at the tip, for comparison with the pre-fix run:**

| cluster | at base | at tip |
|---|---|---|
| `Could not find repo root` | 228 | **0** |
| `artifact lacks an __abi_version export` | 118 | **0** |
| `void kernel ingress … initialization completion failed` | 81 | 84 |
| `Package artifact closure is incomplete` | 42 | 38 *(stale local tier)* |

Two of the four dominant causes are **gone**, which is the four-realm reader fix
showing up in measurement rather than in argument.

### A HAZARD THE BASH WORKTREE GUARD DOES NOT COVER

**Serena's project root is the repository, not the agent's worktree.** An agent
working in `.claude/worktrees/agent-*` made nine edits through Serena's MCP
tools and they landed in the **main checkout** — while every tool call reported
success.

It was caught by a `git diff` in its own worktree returning **empty** after an
edit it had just made. It reverted from pristine copies and verified with
`diff -rq` over `host/src`; the coordinator independently confirmed the main
checkout clean before merging.

**Every agent brief in this campaign carries a bash-level worktree instruction,
and that instruction does not reach MCP tools.** The cheap defence is one
`git diff --stat` immediately after the first edit of a session: if it is empty,
the edit went somewhere else.

Recorded because the failure is silent in both directions — the agent believes
it edited its worktree, and the coordinator's tree changes with no commit to
explain it.

### NDD-K4-4 — `retireCurrentGenerations`, the last worker-entry duplicate

~45 lines per entry, and genuinely undecided. Node awaits
`waitForWorkerQuiescence` plus `terminateThreadWorkers` and releases **exactly**;
the browser never awaits that fence, releases the framebuffer alias, and
**always** force-retires. Sharing it means making the browser await a fence it
does not await today — a teardown-timing change **no Node suite can prove**.

Cost later is now *smaller* than when it was first raised: 45 lines, adjacent,
sitting between three already-shared helpers. D15 remains un-adjudicated.
**Recommendation: take it with the browser teardown pass.** Maintainer's call.

### B28 — provisioning gaps that make suites fail instead of skip

Three findings from the image-backed-bytes work, none of them that item's
subject, all of them costing other agents time.

**`./run.sh setup` does not run `scripts/build-programs.sh`.** It has to be run
explicitly to populate `local-binaries/programs/`. Before that, roughly **30
failures in shard 1/6 were pure missing-artifact noise**. The provisioning notes
do not say so.

**Source-only provisioning never produces `local-binaries/kernel.wasm`.** It
stages `local-binaries/source-only-v1/kernel.wasm`. **Five test files hard-code
the former**, so they fail on a missing artifact rather than skip — and
`host/test/secure-exec.test.ts` goes further and hard-codes
`const hasProbe = true`, which is a skip condition that can no longer be false.
That is the campaign's most common defect shape inverted: instead of a check
that cannot run reporting success, it is a check that cannot skip reporting
failure. Both lie about what was measured.

**`scripts/build-musl.sh`'s own gate blocked every fresh worktree** until
fixed — found **independently by three separate agents**, which is its own
signal about how many worktrees it was costing.

### A coordination failure of mine, and one an agent reported

**Two agents ran a full host Vitest simultaneously** because I recorded the
serialisation rule in this document and not in the briefs. A run does survive
sibling load — one completed at 2,095s against 1,464s alone — but concurrent
runs contend for the cargo package lock, and
`xtask build-deps program-index` is *not* safe against a concurrent `cargo` in
the same checkout, which is the one reproducible way a run dies here.

**Separately, an agent ran `pkill -f 'vitest'` to clear what it believed were
its own stragglers, and killed two sibling runs** — one of them in the main
checkout. It reported this unprompted. That matters twice: it explains failures
the coordinator had attributed to the exit-144 harness reaper, and it means the
144 population was mixed. Without the report the two causes could not have been
separated.

**Rules, now belonging in briefs rather than here:** never use a broad `pkill`
pattern on a shared machine; ask before starting a full host Vitest; and treat
an exit 144 as carrying no test information.

## CONFORMANCE IS UNBLOCKED (2026-09-11) — 1,352 timeouts to 5

| Sortix, 5,114 tests | before | after |
|---|---|---|
| PASS | 3,686 | **4,987** |
| FAIL | 0 | 46 |
| TIMEOUT | **1,352** | **5** |

### The coordinator's hypothesis was wrong, and arithmetic killed it

The brief said the hangs "cluster on time-related syscalls" and blamed the
hand-maintained link contract. The numbers disproved it before any code was
read: the runtime suites total **1,373** tests and timeouts were **1,352**. The
3,686 "passes" were *the entire `include` suite*, which is **compile-only and
never runs a guest**.

So it was never a cluster. It was **every guest-executing test failing, and
none of the others**. `difftime` was the tell — it makes no syscall at all. The
`clock`/`ctime`/`fsync` pattern was **alphabetical ordering**.

Two further parts of the lead were also wrong: `__abi_version` **is** exported
(the glue emits it; the body is `i32.const 44`), and `--allow-undefined` is in
the SDK's own flag list, so it was never a divergence.

**The actual cause: `KANDELO_RUNNER_BUILTINS`.** Every conformance test resolved
the full builtin-program closure — dash, coreutils, the SQLite testfixture,
mysqltest — before starting its guest, **once per test**.
`examples/run-example-builtins.ts` already had an `explicit` mode for exactly
this, already covered by `host/test/run-example-resolver.test.ts`, and **no
runner used it**. A POSIX `asctime` test was failing inside
`binary-resolver.ts` because an unrelated program set would not resolve.

### The duplication lead *was* right, and what it found is worse than a hang

Six scripts hand-maintained the SDK link contract. Linking one test both ways:

| | SDK | the suite's copy |
|---|---|---|
| memory minimum | 146 pages | **2 pages** |
| `__stack_pointer` | 9,546,112 | **109,968** |
| `__heap_base` export | yes | **no** |

**The conformance suite was certifying POSIX behaviour against a ~64 KiB shadow
stack instead of the platform's 8 MiB.** There is no wasm guard page, so a deep
call chain overruns `.bss` rather than faulting — the suite could have been
reporting corruption as conformance. The copies also dropped `cxxrt.c`, the
pinned `-fuse-ld`, the LLD-22 `--no-stack-first` compensation, and the
thread-slot declaration. All three runners now drive `wasm32posix-cc`, at
**+180 ms per link**.

That is the **eleventh** instance of duplicated authority this campaign has
found, and the one with the widest blast radius: it sat under the instrument
that certifies the platform's north star.

### A regression introduced, caught, and fixed — silently, behind `|| true`

Routing executables through the SDK left `SO_CFLAGS`/`SO_LINK_FLAGS` handing
raw-clang flags to the SDK driver, so **every `.so` failed to build behind a
`|| true`**, and `dlopen`/`dlsym`/`dlclose` reported FAIL as though platform
dlopen were broken. Found and fixed in the same item.

### What remains is real conformance data, visible for the first time

- **5 timeouts**, all blocking-wait: `basic/poll/poll`,
  `signal/ppoll-block-raise`, `signal/ppoll-block-sleep-raise` (stable), plus
  `sys_select/select` and `sys_time/select` (load-dependent). These are
  **wait-queue semantics**, owned by that item, not harness artefacts.
- **46 failures**: ~17 controlling-terminal (termios, `ttyname`,
  `ptsname`/`unlockpt`, `tcgetpgrp` — the runner gives the guest no TTY), 20 UDP
  `SO_REUSEADDR` bind-conflict, 4 `net_if`, 3 `nl_types`, 2 socket.

**The browser runners carry the same three duplicate copies** and should get the
same treatment. And one loose thread: every test logs `artifact lacks an
__abi_version export` while the export is demonstrably present — harmless today,
but `policy.rs` turns that same condition into a **hard failure** when a fork
surface is present, so it is a latent trap rather than noise.

### HOST IMPORTS 75 → 73, AND WHY THE TWO REDUCTIONS COMPOSED SAFELY

Two items removed a **different** host import, neither could see the other, and
**both pinned 74**:

- the wait-queue cutover deleted `host_nanosleep` (75 → 74 on its base);
- the image-backed-bytes item collapsed `host_blob_read` and
  `host_fetch_archive` into one `host_fetch_deferred(kind, …)` (75 → 74 on its
  base).

Merged, the built kernel has **73 function imports** plus `env.memory`.

**Why that was safe is the reusable part, and it is not the arithmetic.** Both
agents measured the count by **walking the built artifact's import section**
rather than reporting the pinned constant. Had either reported the constant, the
merge would have landed a pin disagreeing with the kernel, and the gate would
have caught it only as a bare count mismatch — with no way to tell *which* of
the two reductions was wrong.

The trap is live and has caught three agents: a raw import-*entry* count reads
one higher than the function count, because `env.memory` is an entry.

**This is the number that tracks V4.** Production TypeScript is only ≈−3,400
because roughly 9,900 lines of host driver glue offset the deletions — lines can
fall while surface stays flat. These two items are the first on this branch to
take surface *away*, and one of them collapsed a capability rather than moving
it: `host_blob_read` and `host_fetch_archive` were one capability split across
two id namespaces that genuinely overlap, since inode 1 and archive id 1 both
exist.

The open `host_debug_log` question shifted with it and is **still not settled**:
now *72-or-73, pinned at 73*, caller intact.

**The option label I put to the maintainer was self-contradictory, and they
caught it:** the title said keep the import while the body described removing it.
The traced facts, so the next reader does not have to re-derive them:

- the import is declared **once**, at `crates/runtime-core/src/lib.rs:81`;
- it is wrapped by `debug_log()`, cfg-gated to wasm and a no-op natively;
- it has **exactly one real call site** — `report_writeback_loss` at
  `crates/kernel/src/wasm_api.rs:1285`, formatting
  `"shared-mapping writeback lost: pid=… addr=… reason=…"`.

So the "better home" **removes the import** (73 → 72): record the writeback loss
as kernel state readable through an export that already exists, rather than
pushing a formatted string across the host boundary to be logged. That is
strictly better for V4 — one less host capability — and strictly better for the
platform-values contract, because a lost writeback becomes queryable state
instead of a line in someone's console.

**DECIDED (maintainer, 2026-09-11): move it. Host imports 73 → 72.** Their
words: the earlier "keep for now" was answered before anyone had traced the
caller, and one call site formatting one string makes the case for moving it
much stronger. **Dispatched**, with two constraints on the implementation:
prefer an **existing** kernel export (adding an export to remove an import is a
wash for V4, and exports are ABI surface), and if the record has bounded
capacity, a dropped record must itself be visible as a counter — a lost
writeback is data corruption and must become *more* observable, not less.

### THE WAIT-QUEUE CUTOVER SHIPPED A 35% HOT-PATH REGRESSION, AND MEASUREMENT CAUGHT IT

The item's own author expected "roughly neutral" and wrote so. An isolated A/B
over exactly its eight commits, same guest binary, five runs each, median µs/op:

| | before | after | |
|---|---|---|---|
| `epoll_ready` | 30.07 | 42.17 | **+35%** |
| `poll_ready` | 36.18 | 42.59 | **+18%** |
| `poll_timeout` | 1382.1 | 1466.7 | +6% |
| `select_timeout` | 1354.1 | 1443.6 | +7% |

**Cause:** `handleEpollPwait` armed the deadline *before* the readiness probe,
so **every ready `epoll_wait` — the common server-loop case — bought and retired
a deadline nothing read**, at two kernel crossings, one of which calls back into
the host for `CLOCK_MONOTONIC`. Fixed by arming below the probe, once the call
is known to block.

**Three things make this worth recording beyond the fix.**

**The benchmark did not exist, and its absence was invisible.** Nothing in the
suite armed a timeout — `getpid()` and throughput never reach that path. The
agent wrote `benchmarks/programs/blocking-wait.c` and wired it into `syscall-io`
rather than treating a missing benchmark as someone else's problem. Without it
the regression was unobservable, and the item would have shipped with it on the
strength of a plausible analysis.

**The author refused to claim the fix's size.** Two attempts disagreed and both
were discarded: the machine was at load 89 under a concurrent tip-wide suite,
and — the part that matters — its harness alternated eager→lazy in *both* rounds
instead of counterbalancing, so a rising load trend biased one arm
systematically. That is a harness bug found in one's own instrument before
reporting a number, which is the discipline this campaign has spent a day
learning. The claim made was only the shape: *the ready path now does zero
crossings where it did two.*

**The scope left undone was left deliberately.** `select`, `pselect6` and
`sigtimedwait` still arm eagerly — same waste, but `remainingMs` is read from
five branches each, their ready path is not in the benchmark, and the same agent
is about to touch select semantics for the conformance work. Widening the diff
before that is the wrong order.

**What this says about the campaign's performance contract.** Two items shipped
recently with "performance not measured" stated honestly, which the contract
permits. This one had a benchmark *written for it* and still needed a second
look, because the first measurement was taken with a biased harness. Honest
non-measurement and careless measurement are not equally safe: the first leaves
a known gap, the second fills it with a wrong number.

### PROVISIONING: THE CHEAP PATH, AND ONE GATE THAT WILL BITE A CUTOVER

A fresh agent worktree arrives with **nothing** — no submodules, no
`node_modules`, no sysroots, no `local-binaries`. A full source-only
`./run.sh setup` into an isolated cache root rebuilds every package and **may
not finish inside a session**.

**The cheap path that unblocks everything except the rootfs-dependent suites:**

    ./scripts/dev-shell.sh cargo build --release -p kandelo -Z build-std=core,alloc
    ./scripts/dev-shell.sh bash -c 'source scripts/install-local-binary.sh; \
      install_local_binary kernel \
      target/wasm32-unknown-unknown/release/kandelo_kernel.wasm kandelo-kernel.wasm'

That is what unblocked `host-native` and the targeted Vitest files for the B2
opening move. A controlled base-vs-branch comparison needs a full provisioning
pass **twice**, once per side.

**Do not edit Rust while a `setup` runs in the background.** An agent's setup
died with:

    cache key changed while building kernel … refusing publication under the
    pre-build key

**That is the build-freshness gate working correctly**, not a defect — but an
item that edits Rust constantly will trip it repeatedly, so stage the kernel
deliberately with the two commands above instead of leaving a `setup` behind
you.

### VERIFY THE PREMISE BEFORE OBEYING THE PROCESS

The best thing said in this campaign about its own methods, by the agent that
scoped the shared-mapping cutover, on standing down:

> The ordering is not really my recommendation so much as what the evidence
> forced. The reason it has to be "non-empty table under test first" is the same
> reason the item is atomic at all — the Rust has never executed, and I only
> believe that because I re-verified it by call-site census rather than
> inheriting it from the ledger. **If the next agent finds that claim is wrong in
> either direction, the ordering should be re-derived rather than followed.**

This campaign has disproved **seventeen** inherited claims, several written by
the coordinator. A process is only as good as the premise that produced it, and
a process followed on a false premise is worse than no process — it launders a
wrong belief into a sequence of steps nobody re-examines.

Every brief issued from here carries this: **state the premise the ordering
rests on, and instruct the agent to re-derive rather than follow if the premise
fails.**

## B32 — THE CONFORMANCE SUITE IS SILENTLY CORRUPTED ON macOS

`git submodule update --init` of `tests/sortix/os-test` leaves **17 files
modified that nobody edited.**

The cause: git tracks both `include/inttypes/PRIX16.c` and
`include/inttypes/PRIx16.c`, and a **case-insensitive filesystem holds one**.
So `PRIX16.c` ends up containing `#ifndef PRIx16`.

**All 17 are in `include/`** — the compile-only suite of 3,741 tests that
supplies most of this campaign's conformance passes. Those tests **pass while
testing a macro other than their own name**: `PRIX{8,16,32,64}`, the `FAST` and
`LEAST` variants, `PRIXMAX`, `PRIXPTR`, `math/NAN`, and both `FD_SET`s.

That is a silent success **underneath the number the campaign has been quoting**.
The 4,987 passes are not wrong about the platform, but 17 of them are not
testing what their filenames claim, and nothing reports it. Anyone reading
`include` results on macOS is reading a partly fictional suite.

**DECIDED (maintainer, 2026-09-11): build the case-sensitive volume automation
and report the measured cost.** Dispatched, in this order:

1. **Detection first.** The runner refuses, loudly and by name, when the
   checkout is case-collapsed. That protects every future measurement even
   where the image is not used, and it is the actual defect — a suite reporting
   fictional passes.
2. **Then the volume, automated.** Precedent exists but no script:
   `~/.cache/kandelo/KandeloCaseBuild.sparseimage` (47 MB) is present and
   nothing under `scripts/` references it, so it was made by hand. Creation and
   mounting go into provisioning — idempotent, a no-op on Linux, and it must not
   break a checkout that already works.
3. **Then measure.** Wall-clock for the `include` suite on the normal checkout
   versus the case-sensitive volume, plus confirmation that all 17 files then
   differ correctly. The maintainer asked specifically whether this makes
   testing slow; **"negligible" is not an acceptable answer without a
   measurement behind it.**

### B33 — `ppoll` resubmits where Linux returns EINTR, and `pselect6` disagrees

Diagnosed, and **not** the wait-queue item's doing.

Both hanging cases print `SIGUSR1` and then hang: **the mask swap works and the
handler runs; what never happens is the return.** Two independent lines:

- **Pass/fail shape.** Of seven `ppoll-block-*` cases, exactly the two whose
  *only* wake is the signal fail. The five with a pipe write or close all pass,
  because a resubmitted `ppoll` finds something. Suite: 30 pass, 0 fail, 2
  timeout.
- **One-variable probe.** The same test with `sigaction(sa_flags=0)` instead of
  `signal()`'s implicit `SA_RESTART` prints `SIGUSR1` / `ppoll: EINTR` in
  **2.0 s**.

Linux uses `ERESTARTNOHAND`: a caught handler always yields `EINTR`. Kandelo
resubmits. **`pselect6` already makes the opposite choice**, so the two
disagree with each other.

`docs/posix-status.md` corrected from **Full → Partial**.

**DECIDED (maintainer, 2026-09-11): adopt the Linux/POSIX answer — `ppoll`
returns `EINTR`, matching `pselect6`.** The maintainer asked whether Linux
semantics are also POSIX-compliant here. They are, and the suite settles it by
its own convention: `signal.expect/ppoll-block-raise.posix` contains exactly
`SIGUSR1` then `ppoll: EINTR`, and the suite carries **185 `.posix` expectation
files and no `.linux` variants at all**. There is no separate POSIX expectation
to contradict the Linux one. **Dispatched.** The fix must also report, for each
of `poll`, `select` and `epoll_wait`, whether it already agrees — a family where
three agree and one does not is how this started.

### The +35% was load-inflated, and the arming was not the cause

Withdrawn and replaced with counterbalanced, quiet, twice-replicated numbers:

| median µs | before | after | |
|---|---|---|---|
| `epoll_ready` | 26.57 | 30.08 | **+3.5 (+13%)** |
| `select_ready` | 27.12 | 32.13 | **+5.0 (+18%)** |
| `poll_ready` | 31.73 | 31.49 | **none** |

Three corrections by the author, against itself:

- the earlier **+35% / +18%** figures were load-inflated — withdrawn;
- **`poll_ready` never regressed**, exactly as predicted, since `poll` arms
  lazily by construction. The earlier "+18% poll_ready" was an artifact;
- ~~**the arming is not the cost.** Removing it recovers ≈0, in two independent
  isolations that disagree in sign. The lazy-arm fix is **inconclusive**, and
  ~3.5 µs comes from somewhere else in that change that is **not yet located**.~~
  **WITHDRAWN — see "THE 3.5 µs IS REAL, IS THE ARMING, AND ENTERS AT ONE
  COMMIT" below.** The arming *is* the cost: removing it recovers −3.37 µs on
  `epoll_ready`. The two isolations that disagreed in sign were medians taken
  over runs mixing quiet and loaded regimes, which is an estimator that cannot
  resolve 3.5 µs on this machine, not evidence of an absent effect.

**So the `select`/`pselect6` fold-in was deliberately not done.** The instruction
was to measure rather than assume it mirrors epoll; epoll was measured, it did
not behave as assumed, and extending it would have been assumption-driven. The
`select_ready` metric is committed for whoever finds the real cause.

**That deferral is now resolved in favour of doing the fold-in.** The arming has
since been measured to cost 3.4 µs where it was removed, and `select_ready`
still carries +2.7 µs at tip because `handleSelect` and `handlePselect6` still
arm eagerly. It is no longer an assumption that select mirrors epoll.

### THE 3.5 µs IS REAL, IS THE ARMING, AND ENTERS AT ONE COMMIT

**This supersedes the section above on every point except `poll_ready`.**
The claim that "the arming is not the cost" was an under-powered
measurement, not a finding. Removing the arming recovers essentially all
of it.

**The floor first, because it decides whether anything above it is
readable.** Two arms pointing at the *same* commit — two separate
worktrees at `51d908632`, staged identically, running byte-identical
kernel wasm — counterbalanced `A B B A`, 12 runs per arm, at load
average 4:

| | floor (same code both arms) |
|---|---|
| `epoll_ready` | −0.57 µs (min), −0.30 (p10) |
| `select_ready` | −0.70 µs (min), −0.70 (p10) |
| worst of all ready metrics | ±1.5 µs |

**So the floor is ≈ ±0.7 µs on the two metrics in question, and 3.5 µs
is about five times it.** The effect was always resolvable. What was not
resolvable was the earlier *estimator*: medians over runs that mix quiet
and loaded regimes. Two isolations disagreeing in sign was the signature
of that, not of an absent effect.

**Why the estimator mattered more than the replication count.** On this
machine the same build returns ~29 µs run after run, then 300–400 µs for
a burst of consecutive runs when something else starts. Contention only
ever *adds* time, so the distribution is one-sided. In one 24-run
comparison the final three runs were B, B, A and the burst covering them
moved the medians by 80–150 µs while the minima moved by 3. `A B B A`
cancels a monotone drift; it does not cancel a burst landing on an
unbalanced tail. Comparing arms on minima and p10 fixes it, and
`benchmarks/blocking-wait-ab.ts` now does that by default.

**The bisect localizes it to one commit.** Nine worktrees, one per
commit, each with its own kernel built from its own Rust, all sharing
one guest binary and one harness. Counterbalanced, 12 runs per arm,
`epoll_ready` against the base `51d908632`:

| vs base | commit | dMin | dP10 |
|---|---|---|---|
| c1 | `7e5560389` usleep/empty-set epoll | +0.12 | −0.02 |
| c2 | `3834d8058` wait queue, **dormant** | −0.60 | −0.10 |
| **c3** | **`ac5a79a88` wire it in** | **+3.30** | **+3.94** |
| c4 | `f6b2ad1ba` exports + benchmark | +3.12 | — |
| c8 | `0f02d6cf8` end of cutover | +3.91 | +3.89 |

**The step is entirely at `ac5a79a88`, and it plateaus there.** That
commit is host TypeScript only — 422 lines of `kernel-worker.ts` — and
it is the one that replaced the host's `Date.now()` deadline arithmetic
with `kernel_wait_deadline_open` / `_remaining_ns` / `_close`. `c2` gave
the kernel the wait queue while it was still dormant and costs nothing,
which is the control that makes `c3` readable.

**And removing the arming recovers it.** `c8` against `c8` plus only the
lazy-arm fix `69e2fa95d` cherry-picked — 11 inserted lines, no Rust, the
same kernel wasm in both arms:

| | dMin | dP10 |
|---|---|---|
| `epoll_ready` | **−3.37** | **−3.21** |
| `select_ready` | +0.63 | +0.55 |
| `poll_ready` | −1.15 | −0.64 |

`epoll_ready` recovers 3.4 of its 3.9 µs. `select_ready` does not move,
because the fix does not touch `handleSelect` — which is the control
that says the recovery is the arming and not the session.

**What the cost physically is.** An eagerly-armed ready call pays two
kernel entries it never reads — `kernel_wait_deadline_open` and
`kernel_wait_deadline_close` — and `open` additionally calls back into
the host for `CLOCK_MONOTONIC` through `host_clock_gettime`. `poll`
never paid it: it reaches the arming only on the EAGAIN retry path, once
the kernel has already said nothing is ready. That is why `poll_ready`
sits at the floor in every comparison above, and the earlier report of
that is the one thing it got right.

**The registered-interest hypothesis is falsified.** The benchmark now
varies registered-but-idle fds at 0, 16 and 64 while holding the ready
count at exactly one. A cost proportional to registered interests would
make the delta *rise* with that count. It does not — it falls:

| registered idle fds | 0 | 16 | 64 |
|---|---|---|---|
| `select_ready` dMin | +5.88 | +2.68 | +0.41 |

The code says the same thing, and said it first: the wait queue is keyed
by `ChannelGeneration` — one entry per *blocked call*. `epoll_ctl`
registrations never enter it, and the cutover's kernel-side diff touches
only `sys_usleep` and the empty-interest `epoll_pwait` branch, leaving
the interest-evaluation loop alone. The added cost is a *constant* per
call, gated on whether the call arms eagerly. That alone predicts the
whole observed shape without any interest-set mechanism.

**`poll_ready_late` rules out the other explanation.** Every section runs
in one process in a fixed order, so a cost that simply accumulated over a
process's wait history would produce the same shape. Repeating the first
measurement last shows −0.20 to −1.67 µs across every comparison:
position is not the cause.

**What is still owed.** `handleSelect` and `handlePselect6` still arm
eagerly at tip, and `select_ready` still carries **+2.7 µs (dMin) /
+1.4 (p10)** against the base because of it. The fold-in that was
deliberately not done is now the remaining known cost on this path, and
it is no longer an assumption that it mirrors epoll — the arming has been
measured to cost 3.4 µs where it was removed.

**Method note, since this campaign collects them.** The premise handed to
this work — "removing the eager arming recovers ≈0" — was wrong, and the
instruction to verify premises before obeying processes is what found it.
The measurement that overturned it is not more elaborate than the one
that produced it; it is the same comparison with an estimator chosen to
match the shape of the noise.

### B31 confirmed — and repetition is the reason

| `SIGNAL_SAFE_POLL_WAKE_DELAY_MS` | result |
|---|---|
| 0 ms | **11/12 PASS, 1 FAIL** |
| 50 ms | 12/12 PASS |

**The first sweep — 50/5/1/0, one run each — passed at every value**, and would
have supported reporting the constant as unnecessary. Twelve repetitions found
the race. The 50 ms does real work; the evidence bounds 0 as insufficient and 50
as sufficient, and does **not** show 50 is minimal.

A single run of a racy test is not evidence about a race. That is the same
family as this campaign's other measurement failures, and the cheapest guard
against it is repetition.

### B31 — tuning constants whose evidence predates the link-contract fix

`SIGNAL_SAFE_POLL_WAKE_DELAY_MS = 50` (`host/src/kernel-worker.ts:847`) is
justified in-comment by `tests/sortix/os-test/signal/ppoll-block-sleep-write-raise`,
with timing reasoning about a 1–5 ms `Atomics.notify` → `uv_async` round-trip.

**That evidence was gathered against binaries linked with a ~64 KiB shadow stack
and a 2-page memory minimum**, before the conformance runners were moved onto
`wasm32posix-cc`. The binaries under test genuinely changed.

This is not a claim that 50 ms is wrong. It is a claim that **its empirical
basis no longer exists**, and a constant defended by a measurement nobody can
reproduce is a guess with a citation. Cheap to re-check now that the suite runs
against correctly-linked binaries.

**The general form is worth a sweep:** any constant, threshold or timing
justified by a conformance observation predates a real change in what those
binaries are. `SIGNAL_SAFE_POLL_WAKE_DELAY_MS` is the one found so far because
an agent happened to be reading that file.

### The five conformance timeouts collapse to two problems

Before running anything, the wait-queue agent checked the shape of the numbers —
and the set collapsed.

**`sys_time/select` is `sys_select/select`.** Literally:

    /*[XSI]*/
    #include "../sys_select/select.c"

One program compiled twice. `basic/poll/poll.c` is a different file with the
same program shape. All three do this: fill a 64 KiB pipe **one byte at a time**,
then drain it one byte at a time, with an infinite-timeout `poll`/`select`
before **every** operation.

`DEFAULT_PIPE_CAPACITY` is 65,536, so that is ~131,000 wait calls plus ~131,000
reads/writes ≈ **262,000 syscall round-trips** against `TEST_TIMEOUT=30` — a
budget of **114 µs per round-trip**. Measured ready round-trip is **31–46 µs
quiet** (3× headroom) and **419 µs at load 89**, which puts the same work at
~110 s. **A throughput race against a wall-clock budget, not a lost wakeup.**

**And they are not the wait-queue item's.** `timeoutMs <= 0` returns
`WAIT_REMAINING_INFINITE` before the kernel is called, so those paths arm no
deadline and cross no extra boundary — the lazy-arm fix cannot help them either.
The agent said so rather than accepting credit for a fix that cannot apply.

**The two `ppoll` cases are the real question.** Both end in
`ppoll(&pfd, 1, NULL, &empty)` on a pipe nothing writes to; the only exit is a
signal. One relies on ppoll's mask swap making an *already-pending* SIGUSR1
deliverable, the other on cross-process delivery into a parked ppoll 100 ms in.
A timeout there is a **lost signal wake** — the silent-hang class the K3
grounding names as the reason shadow mode exists. Decisive test is base-vs-tip,
which is cheap.

**That coordinator label was noise, and is struck.** "`basic/poll/poll` stable,
the two selects load-dependent" was relayed here without being checked against
the programs. Measured quiet, all three behave identically:

    basic/poll/poll           9.4s  PASS
    basic/sys_select/select   8.9s  PASS
    basic/sys_time/select     9.0s  PASS

~9 s against a 30 s budget is **34 µs per round-trip across 262,000** —
independently matching the benchmark's 31–46 µs. Under load-89 inflation the
same work takes 80–120 s. The prediction made in advance held.

### B30 — a reaped build publishes an authority for a build that never finished

`local_build.rs` gained a retraction: an **incomplete** build now withdraws the
source-only projection authority, so a partial tier resolves to nothing rather
than to a lie. It fires on a failed node.

**It does not fire when the build is killed.** A `./run.sh setup` reaped at 91
nodes (harness exit 144, not a build failure) left the authority *published*,
describing artifacts the build had not finished producing. The resolver then
reports, correctly and unhelpfully:

    whole tier refused: programs/wasm32/dash.wasm is not declared by the
    source-only projection authority (the tier was materialized by a different
    build than the one this projection describes)

That message is true and the tier is genuinely unusable — but the cause is "your
build was killed", and nothing says so. **40 of 93 failing files in a tip-wide
host-suite measurement were this**, i.e. the measurement was of my own partial
provisioning, not of the branch.

The fix shape is the retraction firing on abnormal termination as well as on a
failed node — a trap handler, or publishing the authority only as the final
atomic step. Adjacent to B29: both are cases where an artifact's *state* is
correct and the *explanation* is missing.

### Tip-wide host suite, measured against a current tier and a 73-import kernel

| | base | tip, stale tier | tip, rebuilt tier |
|---|---|---|---|
| Failed files | 103 | 112 | **93** |
| Passed | 259 | 311 | **332** |
| Skipped | **65** | 4 | 3 |
| Failed tests | — | 202 | **154** |

The cluster that dominated every earlier run is nearly gone:
`void kernel ingress kernel initialization completion failed` went **84 → 4**.
`Could not find repo root` and `artifact lacks an __abi_version export` remain
at **0**, where they were 228 and 118 at a mid-campaign base.

What is left, and it is a different shape from before: 47 test timeouts, 40
closure refusals (**B30, mine**), 7+4 `vi.fn()` call-count assertions, 5
`unreachable`, 4 kernel-init, 4 artifact-policy refusals, 3 `SNDCTL_DSP_GETFMTS`.
These are individually readable failures rather than a flood from one
environmental cause — which is the first time that has been true for this suite
in the campaign.

### B29 — a stale kernel artifact fails as "the kernel is broken"

After rebasing onto a new base, `local-binaries/source-only-v1/kernel.wasm` can
predate it. `cargo test -p host-native` then fails — an agent saw **41 failures**
— with:

    failed to find function export kernel_set_process_pointer_width

**That message names the symptom and hides the cause.** It reads as "the kernel
is broken", not "your kernel predates your base". The agent only established the
truth by running `wasm-objdump -j Export` on both artifacts side by side and
finding the export present in the fresh one and absent in the staged one.

The staleness is **invisible in both directions**: the suite does not know its
kernel is old, and the agent does not know either. `verify-fresh` and the
build-key machinery exist precisely for this class, so a gap here is worth
closing — and the fix is mostly in the *message*.

Re-staging also took ~60 minutes, because a large rebase invalidates package
cache keys broadly. Worth knowing when serialising work.

### The unproven half of the image-body window, stated by its author

`host/test/rootfs-image-body-window.test.ts` proves that a host mutation after
boot — materializing a URL-backed lazy file — does not disturb an image-backed
read. It does **not** prove that no mutation can *interleave* with a read. That
half is argued structurally in the code: a synchronous kernel entry cannot
interleave with a same-thread `MemoryFileSystem` call.

**If a later change ever makes that SFFS buffer reachable from a second thread,
that argument is the thing that stops holding.** Recorded by the author rather
than left implicit, which is the point.

### THE TECHNIQUE THAT FOUND WHAT CENSUSES MISS

Stated on its own because it has now worked four times and is not what a census
naturally reaches for.

**Searching for a feature's name misses the code that depends on the feature
without using the name.** Every large census in this campaign undercounted for
exactly this reason:

| census | claimed | actual | what the extras looked like |
|---|---|---|---|
| worker-entry pairs | 16 | 21 | declarations sharing no identifier |
| `usePolling` | 1 | 7 | `usePolling: true` inside an `Object.assign` |
| epoll touchpoints | 14 | 17 | a **default parameter** |
| socket readiness | 5 | 8 | two bare `return events`, one trait **default method** |
| pointer width | 0 named | **17** | twelve `args[5]`, three `si == 5u`, two test assertions |

**What works instead — two cheap habits:**

1. **Sweep the prose, not the identifiers.** The seventeen pointer-width sites
   shared no substring, but their *explanations* did: comments about "the
   private sixth channel slot" and "slot 5". Grepping comments found what
   grepping code could not. Serena's symbol graph finds callers; it does not
   find *conventions*, and a convention is exactly what a magic index is.
2. **For behaviour, diff rather than read.** The last two pointer-width sites
   were test assertions that encoded the retired contract without naming it. No
   search would have found them. A controlled before/after comparison did, in
   one run.

**The corollary for briefs:** when an item's subject is a convention rather than
a symbol — an argument slot, a sign convention, an ordering rule, a per-realm
initialisation — a symbol census will undercount it, and the brief should say
so. Four of this campaign's most expensive findings were conventions:
`args[5]`, the PS/2 Y-axis sign, the per-realm artifact reader, and the
`ProcessLayout` descriptor set.

### HOW TO ATTRIBUTE A FAILURE IN THIS SUITE — the method, and why totals lie

The host suite carries **~103 failing files at any base**. That single fact
invalidates every cheap way of reading it, and tonight it invalidated mine.

**What does not work:**

- **Totals.** 103 → 105 looks like noise and was two real regressions.
- **Error-signature counting.** The dominant signatures on a mid-campaign branch
  were 228 × `Could not find repo root` and 118 × `artifact lacks an
  __abi_version export` — both environmental, both since fixed. An argument
  built on counting them would have been confident and wrong.
- **Targeted suites during development.** The pointer-width item ran the
  relevant suites while building and they were green. Both regressions were in
  files it had no reason to run.
- **Measuring against the current tip.** This was *my* suggestion and it was
  wrong. It answers "what fails on what we ship", which is release confidence,
  not causation — on a branch where the four-realm reader fix and the
  tier-identity fix landed the same night, nothing can be separated from
  anything.

**What works: a controlled comparison, then diff the failing file SETS.**

Run the full host suite twice — at your base and at your branch — on the same
machine, with the same artifacts, and **with each side's own kernel rebuilt and
staged**. Reusing one kernel against the other side's host code manufactures
failures and makes the comparison worthless. Then diff the sets:

    ONLY ON MY BRANCH:  test/multi-worker.test.ts
                        test/kernel-scratch-transfer-boundaries.test.ts
    ONLY ON BASE:       (none)

That named both regressions exactly. Totals and signatures named neither.

**And the claim stays bounded even when the sets match.** Identical failing sets
are *consistent with* no regression; they do not prove it, because many of those
suites boot a real kernel and identical sets do not prove identical causes. Say
which claim you are making.

**Fix the assertions, do not delete them.** Six assertions in
`kernel-scratch-transfer-boundaries` encoded the retired contract — that the
host overwrites channel slot 5 with the caller's width. They were repointed at
what is now true and load-bearing: `setsockopt` asserts the caller's own `99`
*survives*, and the five `ioctl` cases assert the slot stays zero. That property
**is** the reclaim that returns the slot to `preadv2`/`pwritev2`, so the tests
now guard the new contract instead of the old one. Deleting them would have
removed the only thing watching the thing the item bought.

**A standing hazard this exposed.** Synthetic kernels in the host suites must be
told about newly mandatory exports. `host/test/multi-worker.test.ts` now
declares **two** — `kernel_thread_slot_addr` and
`kernel_set_process_pointer_width` — one from each of the last two items to add
one. A third item that adds an export must update that fixture *and* its
`kernelExportNames` list, and its own targeted suites will not say so.

### B24 — channel-level coverage for caller-native record syscalls

**The gap that twelve broken syscalls walked through untouched.**

Twelve syscalls carry a `ProcessLayout` or kernel-dereferenced record whose size
depends on the caller's data model: `statfs`, `fstatfs`, `setitimer`,
`getitimer`, `sigaltstack`, `timer_create`, `rt_sigtimedwait`,
`rt_sigqueueinfo`, `sysinfo`, `mq_open`, the `mq_timedsend`/`mq_timedreceive`
attribute path, and `mq_getsetattr`.

During the pointer-width work **every one of them would have returned `EINVAL`
to every caller**, and the whole suite went green: 257 passing Vitest files, 54
host-native smoke tests, 1,952 runtime-core tests. Nothing exercises them
*through the channel*. `runtime-core` tests call `syscalls::` directly, below
the dispatcher where the bug lived; the host suites mock
`kernel_handle_channel`.

**Where it belongs: `crates/host-native`.** It already instantiates the real
`kernel.wasm` and runs real guests through the real channel —
`smoke_runs_record_path_guest_uname` is that shape today. The mechanics are
free: `crates/host-native/fixtures/build-fixtures.sh` compiles *every* `*.c` in
the directory, so a new fixture needs no build-system change.

**It must be self-extending, not a hand-list.** A hand-written list of twelve is
the same failure mode as the census that missed them. Derive the set from
`SYSCALL_ARG_DESCRIPTORS`: enumerate every entry carrying
`SyscallArgSize::ProcessLayout` and assert each appears in the fixture's
exercised set, so **adding a descriptor without coverage fails the build**. That
is the pattern `host_abi.rs` already uses for its reviewed-set assertions.

**The half it will not cover, stated up front.** `build-fixtures.sh` targets
`wasm32-unknown-unknown` only. A wasm32 fixture would have caught *this* bug
(width read as 0) but not one that only manifests at width 8 — which is the more
likely future regression, since wasm64 is the path with no guests in daily use.
`sysroot64` is built and `host/test/wasm64.test.ts` exists, so a wasm64 arm is
reachable; scope it separately rather than bundling it.

**DONE 2026-09-11.** `crates/host-native/fixtures/native_process_layout.c`
plus two tests in `crates/host-native/src/lib.rs`. Four things the item found
that this section did not predict:

1. **The set is thirteen, not twelve.** Deriving it from
   `SYSCALL_ARG_DESCRIPTORS` immediately turned up `waitid` and `mq_notify`,
   both missing from the hand-list above — which is the case for deriving it,
   made by the derivation itself on its first run.

2. **The native host had no `ProcessLayout` case at all.** `marshal_in` in
   `crates/host-native/src/guest.rs` bailed with "unsupported arg size", so
   all thirteen were unreachable on the one host that runs the real
   `kernel.wasm` with real guests. The coverage could not be written until
   that was implemented (15 lines, mirroring
   `host/src/kernel-worker.ts`'s `pointerWidth === 8 ? wasm64Size :
   wasm32Size`).

3. **Only three of the thirteen are RAW** (`rt_sigqueueinfo`,
   `rt_sigtimedwait`, `waitid` — `crates/shared/src/host_raw_syscalls.rs`).
   The other ten ride the Phase 2 opaque record path, where the guest glue
   sizes its own spans and the host is out of the data path entirely. So the
   size agreement this item protects is host↔kernel for three of them and
   guest-glue↔kernel for ten — worth knowing before anyone reasons about
   where a width bug could hide.

4. **`waitid` is still TypeScript-host-owned.** The Rust kernel has no
   dispatch arm for it; child matching lives in `host/src/kernel-worker.ts`.
   On the native host it returns ENOSYS. The fixture asserts that ENOSYS
   rather than skipping the call, so the day `waitid` moves into the kernel
   that assertion fails and forces real coverage in its place.

The guard was demonstrated failing three ways before being trusted: adding an
uncovered `ProcessLayout` descriptor (names syscall 9), deleting a syscall
from the fixture (names syscall 335), and building a kernel whose
`current_caller_pointer_width` reports 8 for a wasm32 caller — the actual
regression class, which fails at exit code 4 on `statfs`.

One claim was made and then retracted: the fixture's canaries do NOT catch a
width error, because nine of the ten record-path syscalls never have a
host-sized span copied into guest memory, and the two RAW records that do are
128 bytes at both data models. The content assertions are what catch it. See
the second commit.

**Still owed here:** the wasm64 arm, unchanged from the scoping above; and
`setitimer`/`getitimer` value round-tripping, which needs `ITIMER_REAL` and so
needs `host_set_alarm`, an import the native host deliberately leaves to
`define_unknown_imports_as_traps`. The fixture uses `ITIMER_VIRTUAL`, which
exercises the marshalling but not the values.

### Still owed, in dispatch order — refreshed 2026-09-11

**In flight (4):** the wait-queue cutover (B8, monotonic-clock deadline fix
banked), W-1 image-backed bytes (**host imports 75 → 74 banked** — the first
import this branch *removes* rather than trades), the conformance timeout
investigation, and B27a+b (native pointer-width registration + the wasm64
coverage arm).

**Owed, unowned, in order:**

1. **B2 (with B3)** — the shared-mapping coherence layer plus the anon/file
   mapping cutover, ~2,700 TypeScript lines. **The largest remaining deletion on
   the branch.** Blocked on nothing but file locality: it needs
   `crates/runtime-core/src/syscalls.rs`, which B8 holds. Dispatch with the
   fd-facts kernel export as its first commit — about 300 of B2's lines are host
   code re-deriving facts the kernel already owns, including 93 that
   hand-assemble a synthetic `fstat` channel and then recover the host handle by
   snooping the kernel's own `host_fstat` call.
2. **B4** — the measured 3.7× SysV regression. Shipping a known, measured
   regression contradicts the performance contract. Zero-import remedy already
   identified. Same file lock as B2.
3. **The conformance timeouts' remedy**, once the investigation reports.
4. **W-2 → W-3 → W-4** — the rest of the image-writer split, after W-1 lands.
5. **B25** — the per-realm artifact reader. *Needs a maintainer decision first*,
   not more work: either the "not installed in this realm" diagnostic is
   browser-only now and its test should say so, or the five realms install
   explicitly and something must fail when a sixth forgets.
6. **NDD-K4-4** — `retireCurrentGenerations`, the last worker-entry duplicate.
   Recommended to travel with the browser teardown pass.
7. **B10, B11** — small, no ABI surface.
8. **T4** — the residual host-suite failures, re-measured against the rebuilt
   tier. The previous 112 was taken against a tier published before the
   tier-identity fix and is not a code number.
9. **B27c** — `setitimer`/`getitimer` value round-trips, which need an import
   the native host deliberately traps. Left open rather than stubbed
   dishonestly.

**Not in this campaign, by decision:** the ~9,900-line driver-glue audit
(campaign two's charter), B14's SysV conformance tests, NDD-BOOT-1.

### NDD-BOOT-1 — `boot-descriptor.ts` (507), not started

A6 scoped it and stopped, correctly. Its only production caller runs on the
**browser main thread with no kernel instance** (`live-setup.ts:1076`, against
the kernel-bearing path at `:1286`); `host/src/**` has zero references. A
migration needs a standalone main-thread Wasm module and **no precedent
exists** — `detectPtrWidth`, the precedent cited when this was scoped, is plain
TypeScript. Cost: 507 lines plus ~63 types inside a KEEP-marked file, a new
module kind, build and Vite wiring, a sync→async contract change, and an
error-`code` discriminant crossing the boundary. **Maintainer's call.**

### B7 — epoll OFD ownership (DONE 2026-09-10)

**The register's "one change, not two" was verified before being built on,
not inherited.** The grounding (`2026-09-09-k3-blocking-scheduler-grounding.md`
§4.4, §11.3) splits this into D2 (fork inheritance) and D3 (OFD re-keying) and
calls D3 "separable". It is not. `Process::epolls` was a per-process
`Vec<Option<EpollInstance>>`; genuine sharing means the instance cannot live in
`Process`, and once it does not, the interests it holds cannot be numeric fds,
because the same number means different things in different processes.
**Treat §4.4's D2/D3 split as superseded.**

**The refused shortcut, for the record.** Copying the instance into the child
gets the common case right and is silently wrong on shared mutation. It was not
taken. Both directions of visibility are proved — the child's `epoll_ctl` seen
by the parent and the parent's seen by the child — precisely because a
child-only test would also pass against the copy.

**Where ownership lives now:** `descriptor_backing::with_epolls`, the
kernel-global OFD-keyed backing table that already owned eventfd, timerfd,
signalfd, memfd, procfs and PCM. Epoll joins `manages_ofd`,
`is_live_managed_ofd`, `add_ref_for_ofd` and `release_for_ofd`, so fork takes
the child's reference through `bump_inherited_resource_refcounts` and exec
releases CLOEXEC-dropped ones through `removed_backings_for_exec`. Both
`epolls.clear()` calls in `fork.rs` are gone. `EpollInterest` carries the
registered description's `OfdId` beside the descriptor number, mirroring
Linux's `(struct file *, fd)` key.

**No ABI motion.** No new `env.host_*` import (surface stays **76**), no new
kernel export, and `epolls` was never in the fork wire, so `abi/snapshot.json`
is untouched.

**Conformance: there was none.** `tests/posix` and `tests/libc` contain no
epoll behaviour test at all — checked, not assumed. All of `tests/` holds one
incidental `EPOLLOUT` readiness check inside a UDP backpressure case and a
struct-layout assertion in `tests/abi`. This is the same shape as B14 (SysV).
A first case now exists at
`tests/sortix/os-test-local/basic/sys_epoll/epoll-fork-shares-instance.c`,
picked up automatically by the `basic` suite.

**It compiles but has never executed, and B7 is therefore NOT conformance-
validated.** The runner dies before reaching any guest — see "B19, measured"
below. The Rust behaviour is covered by eight unit tests (four committed red
first, three mutation-verified), which is unit evidence, not inheritance
semantics observed through libc. Run this case as soon as B19 clears.
Note also that the default `TEST_TIMEOUT=30` in `scripts/run-sortix-tests.sh`
is too short for a first kernel boot on a loaded machine: two known-good
control cases (`unistd/fsync-directory`,
`spawn/posix_spawn_large_environment`) also timed out at 30s and needed 120s.

**What B6 must know.** *(Answered: B6 deleted the mirror on 2026-09-10 —
see "B6 — epoll mirror deleted" below. Kept as the reasoning that scoped it.)*
The host mirror (`kernel-worker.ts`, `epollInterests`)
was not merely a second authority but a **weaker model** of the kernel's:
keyed `pid:epfd` on numeric fds and copied per process at fork, where the
kernel keys `(fd, OfdId)` and shares one instance. Its comments have been
corrected to say so. Any divergence is the mirror being wrong. Its one
surviving reader is `resolveEpollReadinessIndices`, a wake-index hint; a
fork-shared epoll can now diverge there, which is not a regression — that case
returned `EBADF` before — but it is one more reason to delete the mirror rather
than repair it.

**Residual gap, left visible rather than papered over.** An interest naming a
description the *calling* process can no longer reach contributes nothing to
its wait. That is exactly Linux when the description is dead, and a divergence
while only a sibling process still holds it. Closing it needs readiness
evaluation against an OFD the caller does not hold, which `sys_poll`'s
`&mut Process` shape cannot express today. `epoll_ctl()` and `epoll_pwait()`
therefore stay **Partial** in `posix-status.md`; `epoll_create1()` becomes
**Full**, and the `exec()` row's epoll numeric-fd gap is gone.

### B6 — epoll mirror deleted (DONE 2026-09-10)

**Ledger.** `host/src/kernel-worker.ts` -423 / +112, net **-311 lines**,
plus +3 in `kernel-scratch.ts` (registering the new export's name and pointer
role). Rust: +155/-26 in `runtime-core/src/syscalls.rs`, +105/-1 in
`kernel/src/wasm_api.rs`, +16/-2 in `shared/src/host_abi.rs`. Tests: -38 net
across five host suites. Both `+` figures include doc comments carrying the
reasoning; the deleted code carried almost none.

**What the census found, and where grep would have been wrong.** The mirror
was not 14 touchpoints, it was 14 plus three the grounding did not name: the
`ExecFdMirrorPrunePlan` interface field, its `KernelWorkerExecFdMirrorState`
test-facing declaration, and `inheritHostFdMirrors`'s `includeEpoll`
parameter — a *default* argument, invisible to any grep for `epollInterests`,
whose one `false` call site carried a comment claiming "Epoll backing tables
are not yet cloned by `spawn_child`". That comment was already false: after B7
the instance is reached through the inherited description, so nothing needs
cloning. The parameter existed to describe a gap that had closed.

**Three host handlers went, not one.**

`handleEpollCreate` was pure duplication. `epoll_create1` and `epoll_create`
have no pointer arguments, and the kernel dispatch already maps 378's ignored
`size` to `flags = 0` (`wasm_api.rs:5815`). The handler hand-built a channel
record and called `kernel_handle_channel` — which is what the generic path
does — solely so it could seed the mirror afterwards.

`handleEpollCtl` hand-marshalled `struct epoll_event` into `CH_DATA` and
rewrote argument 3 as a scratch address. That is exactly what a
`SYSCALL_ARG_DESCRIPTORS` entry does, so `epoll_ctl` now declares one and the
hand-written copy is gone. `epoll_ctl` stays in the Phase 2 RAW set, which is
the same arrangement `poll` (60) already has: RAW on the guest side,
descriptor-marshalled on the host side.

`handleEpollPwait` stays, minus its two mirror gates. **This is a real floor,
not a dead one**: the *wait* is host-owned, as `poll`'s is, until B8 lands the
K3 blocking scheduler. The kernel is dispatched with `timeout = 0` as a
non-blocking readiness evaluation and the host loops to the caller's deadline.
Its `-EBADF` gate and its empty-interest short-circuit were both redundant
against `sys_epoll_pwait` and are gone; an unknown `epfd` is now the kernel's
`EBADF` (and `EINVAL` for a descriptor that is not an epoll instance), and an
empty interest list is the kernel's zero-event answer landing in the ordinary
timeout handling.

**The one genuine reader, moved rather than deleted.**
`resolveEpollReadinessIndices` walked the mirror to call
`kernel_get_socket_recv_pipe` and `kernel_get_fd_accept_wake_idx` once per
interest. It now calls one export, `kernel_epoll_wake_indices(pid, epfd, kind,
out, len)`, which does the join in Rust against the kernel's own list. Two
improvements fall out. It is now scoped to the `epfd` actually being waited
on — the mirror version unioned every epfd the pid held, so an unrelated
instance's descriptors produced spurious wakes. And it shares
`epoll_resolved_interests` with `sys_epoll_pwait`, so the tokens a wait parks
on and the interests it evaluates cannot drift apart. Deleting the tokens
outright was considered and rejected: the retry timer caps at 10 ms, so their
absence is a latency regression, and an unmeasured one.

**Host import count: 75, unchanged**, measured from the built
`kandelo_kernel.wasm` import section rather than inherited. The new surface is
a kernel *export*, not an `env.host_*` import.

**No ABI bump.** `abi/snapshot.json` gains the export signature and the
`"240"` descriptor; both are additive, one epoch, ABI 44.

**A latent defect found by the census and fixed.** Both the host handler and
`kernel_epoll_ctl` accepted a null `event` for every operation, substituting
`events = 0, data = 0`. For `EPOLL_CTL_ADD` that silently registers an
interest that can never report anything, and returns success while doing it.
Linux returns `EFAULT`. Fixed in the kernel; the `epoll_ctl()` row of
`docs/posix-status.md` records the behaviour.

**A latent defect found and NOT fixed — `epoll_pwait` ignores its signal
mask.** `handleEpollPwait` validates the caller's `sigset_t` pointer and its
size, then zeroes channel arguments 4 and 5 and never passes the mask to the
kernel. `sys_epoll_pwait` supports `sigmask: Option<u64>` and never receives
one, so the atomic mask swap that is the entire reason `epoll_pwait` exists
separately from `epoll_wait` does not happen. This is not fixable at the host:
the mask must hold for the duration of the wait, and the host owns that wait
as a sequence of `timeout = 0` probes, so applying and restoring it per probe
would be a different guarantee wearing the same name. **It closes with B8**,
when the kernel owns the wait. Recorded here rather than papered over.

**A dead-test finding, adjacent.** Every `#[cfg(test)]` module inside
`crates/kernel/src/wasm_api.rs` is unreachable: `lib.rs:14` gates the module on
`target_arch = "wasm32"`/`"wasm64"`, and `cargo test` runs on the host target,
so none of them has ever executed. `getgroups_destination_tests` is one
example. This is the dead-floor pattern applied to tests, and it is why this
item's null-event predicate lives in `runtime-core` instead of beside the
export that calls it. Not chased further.

**Conformance: still none, for the reason B19 names.** `tests/posix` and
`tests/libc` hold no epoll behaviour test, and B7's first case
(`tests/sortix/os-test-local/basic/sys_epoll/epoll-fork-shares-instance.c`)
still cannot execute. `scripts/run-sortix-tests.sh` stops at
`Binary not found: kernel.wasm`, and a full `./run.sh setup` does not produce
one: the `kernel` package builds green and stages its artifact, but the
install never lands it in `local-binaries/`. This item rests on unit and
Vitest evidence, and it inherits B7's caveat rather than clearing it.

**The Vitest evidence is a comparison, not a pass.** A locally built worktree
cannot boot a kernel, so most of the suite fails for B19's reasons either way.
The full 428-file suite was therefore run twice against the same artifact set —
once at this branch's tip, once at the campaign tip `3773ce32a` in a worktree
sharing the same `local-binaries`, `sysroot` and `node_modules`:

| | failed | passed | skipped |
|---|---|---|---|
| campaign tip `3773ce32a` | 146 | 255 | 27 |
| this branch | **144** | **261** | 23 |

Every one-sided difference was chased rather than assumed. Four suites fail
here and not at the tip — `accept-signal-guest`, `mmap-file`, `sigpending`,
`node-lazy-archive-runtime` — and all four were *skipped* at the tip, not
passed, because that worktree lacks the `examples/*.wasm` fixtures. Linking
the fixtures in and re-running them there reproduces three of the four
failures identically; the fourth still skips for want of a different artifact,
and its failure here is the same `exit -1` never-booted signature as the other
twenty-nine. **No suite regressed.**

The failures are dominated by two errors, both raised by
`host/src/binary-resolver.ts` — untouched by this item —
before any guest starts: `Package artifact closure is incomplete: no single
provenance tier contains every accepted...` and `Could not find repo root`.
That is B19.

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

### B19, measured — why a locally built worktree cannot run any kernel-booting suite

Found while trying to run B7's conformance case. The failure is **not** a
missing artifact, which is why "build it and continue" does not clear it.

`examples/run-example.ts` — the entry every Sortix, libc and POSIX case goes
through — asks the resolver for its builtin program closure, and gets:

```
Package artifact closure is incomplete: no single provenance tier contains
every accepted artifact, and tiers will not be mixed.
  source-only-v1: shared package identity rejected: a mutable source-checkout
                  wasm tree is not an installed package identity
  local-binaries:      programs/wasm32/dash.wasm (missing)
  binaries:            programs/wasm32/dash.wasm (missing)
  installed package:   programs/wasm32/dash.wasm (missing)
```

**`dash.wasm` is present** — `source-only-v1` held 108 built programs at the
time. The tier is rejected for a *different* reason: `binary-resolver.ts`
(~`:3174`) requires every member of a multi-member package to be a **symlink**
into `.kandelo-local-generations`, and refuses a set of regular files unless
`tier.allowRegularFileClosure`. A locally built `source-only-v1` contains
regular files, so the moment a program closure needs any multi-member package,
the whole tier is refused and the other three tiers are empty.

**Confirmed against a near-complete tree, so it is definitively not a missing
artifact.** A later `./run.sh setup` drove the graph to only **four** package
failures — `gzip`, `xz`, `nginx`, `php` (the last three blocked behind the
first two) — with `dash`, `coreutils`, `login`, `perl`, `node` and the
`rootfs` package all succeeding and `platform-rootfs` reporting success. The
conformance case still failed with the identical tier-identity error. Whatever
else that setup run is worth, it removes "you just have not built enough" as
an explanation. (`gzip`/`xz` failing is its own finding, adjacent to B17 and
what blocks the `shell` product and every image below it; not chased here.)

**Do not work around this by hand-placing artifacts.** Copying a built
`kernel.wasm` to the scalar mirror was tried and made things worse: the
resolver then refused it, and `install-local-artifact` refused to replace it
("refusing to replace regular file at scalar mirror"). Hand-symlinking a
program to satisfy one suite is exactly the special-casing the values contract
forbids.

**Two adjacent defects were fixed on the way** and are no longer part of this
(commits `12118ac68`, `4034dee7e`): a stale `scripts/resolve-binary.bundle.mjs`
still demanding K6's five deleted sizing exports, and `run-example.ts` asking
for perl by its legacy flat path. Both had the same shape as B19 — invisible
until someone rebuilds, and reported as something other than what they were.

### C. Closed by measurement, kept only so they are not re-opened

`host_futex_wait` · `host_sigsuspend_wait` · `host_debug_log` declared-vs-linked ·
the E1 GC blockers · the V8 `epoll_pwait` crash · the four-JS-act dylink floor ·
the K1b callerless `assertImageKernelAbi` · `netif.rs`'s "cannot itself reach" ·
OPFS-as-live-floor · the `constants.ts` "re-export shim" KEEP · the
pre-/post-kernel two-category framing · "16 inseparable pairs" · "~30 ABI-43
strings" · the `describeWasmArtifactPolicyFailures` holder · wasmtime-exnref ·
K1 step 5's "`entries[]` is redundant once the kernel reads `KLZY`" · K1 step
5's "~2,000 lines across `memory-fs.ts`/`sharedfs-vendor.ts`".

**Seventeen disproved claims. Seven were written by the coordinator.**

The `assertImageKernelAbi` entry above is worth re-reading: it was closed by
measurement, recorded here, and then inherited as fact AGAIN by the B1 brief
on 2026-09-10. Closing a claim in this list does not stop it propagating
through documents that were written before the correction. Two plan files
still carried the dead-code reading when B1 was dispatched
(`2026-09-09-k1b-image-format-grounding.md` §7.4, now corrected in §7.5, and
`2026-09-09-k1-sffs-wiring-grounding.md:552`, still uncorrected).

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

## EVERYTHING REMAINING, AND THE ORDER THAT FINISHES IT FASTEST (2026-09-11)

**Scope decision, maintainer, 2026-09-11: there is no deferral list any more.**
W-2, W-3, W-4, B10, B14, B29, B30, B31 and T4 are all IN SCOPE for PR #1350,
alongside the items already in flight. The instruction was explicit: *do not
order these by value — assume every one of them is being done, and take them in
whatever order finishes the whole set soonest.* That is a different question
from "what matters most", and it has a different answer.

### What actually limits throughput here

Not the number of agents. Agents in isolated worktrees are cheap and genuinely
parallel. Three other things are not:

1. **File contention between lanes.** Two agents editing one file do not go
   twice as fast; they produce a merge that compiles by luck. Lanes below are
   drawn around file ownership, not around subject matter.
2. **Machine-monopolising singletons.** Exactly three kinds of work take the
   whole machine: a full host Vitest (only one may run at a time), a package
   build (`run.sh browser` / `local-build`, which saturates every core for
   tens of minutes), and a benchmark round (which needs the machine *quiet* --
   the measured noise floor is ±0.7 µs at load 4, and this campaign has already
   withdrawn one number taken at load 89).
3. **The integration window.** The main worktree cannot be edited while a build
   is reading it. Proved the expensive way on 2026-09-11: a `git cherry-pick`
   run during a `local-build` produced `cannot find writeback_loss in
   runtime_core` -- a kernel "compile failure" with nothing whatever wrong with
   the code, which cost a full build pass to discover.

### The lanes

Each lane is serial *within itself* and parallel *with every other lane*. The
"owns" column is the contract: an agent in one lane does not edit another
lane's files without saying so in its report.

| lane | items, in order | owns | why serial inside |
|---|---|---|---|
| **A — mapping & syscalls** | B2+B3 → B4 | `runtime-core/{memory,ofd,syscalls,process_table}.rs`, `kernel/wasm_api.rs` | B4's remedy is in `syscalls.rs`, which B2+B3 is rewriting |
| **B — wait path & signals** | select/pselect6 fold-in + `ppoll` dead code → B31 | `kernel-worker.ts` wait branches, `libc/glue/channel_syscall.c` | B31 re-measures a constant living in the code the fold-in rewrites |
| **C — image writer** | W-2 → W-3 → W-4 | `sffs.rs`, `images/`, `rootfs-overlay-export.ts`, `entries[]` | strictly sequential by construction: writer, then streaming, then cutover |
| **D — build & staging truthfulness** | B29 + B30 together | xtask build engine, staging/freshness messages | same subsystem; splitting them means two agents in `local_build.rs` |
| **E — conformance** | 46-failure triage → B14 | `tests/` | triage tells B14 what coverage is actually missing |
| **F — process/exec** | B10 | spawn preflight | design-first; blocked on a prepared-target token, not on effort |
| **G — test hygiene** | T4 | `host/test` residue | explicitly sequenced after T1–T3; most of it should vanish with them |
| **H — validation & browser** | clean package build → B20 (incl. Playwright worker realm) → `verify-fresh` → full host Vitest → curation | the machine | every item here is a singleton |

### The scheduling rules, in the order they matter

1. **CORRECTED 2026-09-11, same day: lane A is the critical path, not lane C.**
   The original rule here named lane C on the strength of this document's own
   figures for lane A, and those figures were wrong. Measured at the tip rather
   than inherited:

   - the host side is **2,776 lines across 71 methods** with ~50 call sites,
     not ~2,500 across 57;
   - `shared_mapping_policy.rs` is **1,108 lines with zero production
     callers** -- the only references outside the file are a doc comment in
     `memory.rs` and its own `pub mod` line;
   - `SharedMappingResolver`'s only `impl` is the test double at line 615 of
     the same file. **There is no production resolver;**
   - the per-syscall *range* policy is unported: only `pwrite` is
     range-precise, everything else reloads a whole backing;
   - of the kernel exports touching the mapping table, eleven are `_sysv_` /
     `_ipc_shm_`. **Nothing drives the anon/file table.**

   So B2+B3 is not "a cutover, partly done". It is a **dead floor** -- a
   well-shaped layer that has never executed -- and it is nearer 15% done than
   half. It also ends in the one link that cannot parallelise, because the host
   deletion lives in `kernel-worker.ts`, which lane B owns.

2. **Lane C still starts early and never idles.** It is the second-longest
   chain, it contends with nothing, and the reasoning that put it first still
   holds against everything except lane A: every hour it is not running is an
   hour added to the end. It is not the highest-*value* item, which was always
   the point of scheduling by throughput.
3. **Lanes D, E, F and G are short and contention-free.** They fill agent slots.
   Do not hold them back for a tidy "wave" -- a wave is a synchronisation
   barrier, and barriers are how parallel work becomes serial work wearing a
   costume.
4. **At most one singleton at a time**, and a benchmark round additionally
   requires load ≤ 5. A lane that needs a measurement says so and waits for a
   lull rather than measuring under load; a number taken at load 90 is not a
   cheap number, it is a *wrong* number that must later be withdrawn, and
   withdrawing it costs more than waiting did.
5. **Integrate continuously; never batch merges.** Each lane's output is
   cherry-picked as it lands, in a quiesced window with no build reading the
   tree, and every window ends with a **wasm32 kernel build** as well as native
   tests. Native-only is not sufficient -- see the trap below. The longer two
   lanes' output sits unmerged, the more likely they have both edited the same
   path in ways that merge cleanly and do not compile.
6. **Lane H is the tail and cannot be compressed.** Its contents depend on A and
   C being done, so the total is roughly `max(A, C) + H`. That is the whole
   argument for rule 1.

### Lane A, decomposed (2026-09-11) — because the risky part must be last

Splitting this does not make it smaller. It makes the part that can silently
corrupt data small, late and reviewable on its own.

| | what | collides with | risk |
|---|---|---|---|
| **A1** | production `SharedMappingResolver` (fd→key, path→key) | nothing | low, additive, unit-testable |
| **A2** | the ~15 kernel exports that drive the anon/file table | nothing | low, additive; grows ABI *export* surface, permitted under ABI 44 as one unreleased epoch but must be reported, never silenced |
| **A3** | port the per-syscall range policy | nothing | low; this is what makes the layer *correct* rather than merely present |
| **A4** | give `shared_mapping_policy.rs` its first production caller | — | **high.** The moment the dead floor stops being dead, and the first real behaviour change |
| **A5** | delete and rewire the 2,776 host lines | **lane B**, in `kernel-worker.ts` | **highest.** Where the −2,776 TypeScript actually lives |

**The risk argument is the decisive one, and it is already evidenced.** This is
`MAP_SHARED` coherence, where the failure mode is silent corruption -- and the
current suite demonstrably does not cover the paths the cutover turns on: the
writable-upgrade path of `get_or_create_file_backing` was reached by **zero of
2,037 tests**, a `panic!` at its head failing nothing, and it is the only place
a live backing's host handle changes. A suite that cannot see that path today
cannot be trusted to catch what A4 switches on. Build the coverage before A4,
not after it.

**DECIDED (maintainer, 2026-09-11): all five links ship in PR #1350.** The
natural PR boundary after A3 was offered and declined, so the cutover is not
split. What that buys is the campaign's largest remaining TypeScript deletion --
**−2,776 lines**, which roughly doubles the production-TS figure the ledger
currently carries. What it costs is that #1350 now contains the riskiest change
on the board, and one link of it is blocked behind another lane.

Two consequences follow, and neither is optional:

1. **A5 waits for lane B to clear `host/src/kernel-worker.ts`.** Two agents in
   the syscall hot path of that file produce a merge that compiles by luck --
   the exact failure already paid for once today, when two lanes edited the
   mapping loss path and git merged them cleanly into a tree that did not build.
2. **The coverage comes before A4, not after it.** "What tests would have to
   exist before this layer is switched on" is a deliverable of A3, not an
   afterthought of A4.

### What would make this slower

- Running lane C late "because the mapping cutover matters more". It does matter
  more. It is also not the constraint.
- Two agents in `syscalls.rs` or `kernel-worker.ts` at once.
- Holding short items until a long one finishes.
- A package build started while agents are mid-compile, or a cherry-pick started
  while a package build is reading the tree.
- Measuring anything while the machine is loaded.

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

### Added 2026-09-11 — all of these cost real hours the same day

- **A clean textual merge is not a semantic merge.** Two tiers both edited the
  shared-mapping loss path: one deleted `runtime_core::debug_log`, the other
  added a new caller of it. Neither touched the other's lines, so git reported
  no conflict -- and the tree did not compile. **Native tests could not see it**,
  because the deleted sink was `cfg`-gated to wasm. Every integration window
  must end with `cargo build --release -p kandelo --target
  wasm32-unknown-unknown`, not just `cargo test`.
- **Do not edit the worktree while a build is reading it.** A `git cherry-pick`
  rewrites many files in sequence, and `local-build` compiling against that
  tree saw a torn snapshot. The resulting error named the kernel and blamed the
  code. Quiesce first.
- **`git commit` commits the INDEX, not the paths you just `git add`ed.** A
  `git rm` staged earlier in the session rode into an unrelated commit, and left
  every commit after it carrying a `vitest.config.ts` that pointed at a deleted
  file -- a broken HEAD nobody noticed because the suite could not start to
  report it. Read `git diff --cached --stat` before every commit.
- **On this machine, compare minima and P10, never medians.** The same build
  returns ~29 µs run after run, then 300-400 µs for a *burst* of consecutive
  runs; contention only ever adds. In one 24-run comparison a burst across an
  unbalanced tail moved the **medians by 80-150 µs while the minima moved by 3**.
  That artifact is why two isolations of the same effect disagreed in sign, why
  a real 3.5 µs regression was reported as ≈0 for a day, and why a +35% figure
  had to be withdrawn.
- **Measure the instrument before the code.** The noise floor here is ±0.7 µs at
  load 4, established with two worktrees at the *same* commit and byte-identical
  kernel wasm. Without that number, "we cannot resolve this" and "there is
  nothing here" are indistinguishable.
- **A duplicate object key is a silent deletion, not a merge.** `tsup.config.ts`
  carried two `external:` properties from two changes merged by keeping both.
  JavaScript keeps the last, so half of it had never done anything.
- **An override that cannot cross the dev-shell boundary reports success and
  does nothing.** `--ignore-environment` strips anything not in `--keep`, so a
  variable read inside but set outside is accepted and ignored. Three instances
  found: `KANDELO_SOURCE_CACHE_ROOT`, `KANDELO_OS_TEST_DIR`,
  `WASM_POSIX_BINARY_CACHE_ROOT` (plus `KANDELO_CASE_IMAGE_DIR`, caught before
  it bit anyone).
- **A sweep that returns "nothing found" is a claim, and must be sanity-checked
  like one.** A check for stripped environment overrides reported zero missing;
  the true answer was 441. `for v in $READ` does not word-split in zsh, so the
  entire list became one grep pattern whose embedded newlines made it match.
  It looked exactly like a clean bill of health from a check that never ran.
- **Do not run `./run.sh setup` to make one check runnable.** It pulls the whole
  package closure -- openssl, vim, mariadb, ruby, perl. One agent did it to
  reach `verify-fresh` and took the machine to load 147 for an hour. Build the
  kernel and stage it instead.
- **The import-entry trap has now caught four agents.** 72 host *functions*
  reads as 73 *entries*, because `env.memory` is an entry. Measure the built
  artifact and say which you are counting.
- **Seven agents have been handed the campaign merge-base**, ~1,000 commits
  behind, by the worktree tooling. Every brief must open by verifying the base.

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

## B5 — K11 device pieces 2, 3 and 4, second pass (2026-09-10)

The brief sized these at ~2,300 lines and said the file-ownership block had
cleared. **Ownership was the blocker for exactly one of the three.** For the
other two the blocker was structural, the grounding had named it imprecisely,
and re-deriving it precisely is most of this item's value.

Worktree `.claude/worktrees/agent-abc60c6fa9897b848`, base `d34e9ed01`.

### Piece 3 — WebGL command decode: CUT OVER

**TS −105 production (−100 net including tests), Rust +626.**

`crates/runtime-core/src/dri/cmdbuf.rs` now decides whether a `GLIO_SUBMIT`
span is a well-formed command stream — framing plus every opcode's payload
shape — before `HostIO::gl_submit` is called. `validateCommandBuffer`, the
per-opcode payload-shape table and its four helpers are deleted from
`host/src/webgl/bridge.ts`; `host/src/kernel.ts` no longer calls it.

**No new host import, no new kernel export, no ABI delta.**
`host_proc_read_bytes` already existed and `abi/snapshot.json` is unchanged.

Two things the move fixed rather than merely relocated:

- **Only the browser had the rule.** Node and host-native forwarded whatever
  the guest wrote. The same malformed buffer was a clean `EINVAL` on one host
  and undefined behaviour on the others.
- **`GLIO_SUBMIT` is now all-or-nothing.** The host bridge validated each
  record immediately before dispatching it, so `[valid, malformed]` issued the
  valid command into the live WebGL context and *then* returned `EINVAL` —
  user space told the submission failed while the context had advanced.

**The validator does not copy the command buffer**, which matters because the
cmdbuf is 1 MiB and this is a per-frame path. Shape checking reads a record's
4-byte header and at most 36 payload bytes (the deepest field any rule
inspects is `OP_TEX_IMAGE_2D`'s `dataLen` at offset 32), so the walk uses a
4 KiB sliding window and *steps over* payload bodies. Two unit tests assert
that accounting, not just the answer, using new read counters on the shared
`GuestMemoryHost` double.

One behaviour narrows, documented in both files: bytes the kernel would have
refused can still reach the bridge if a process rewrites its own cmdbuf from
another thread while blocked in its own `GLIO_SUBMIT`. That race predates the
change (the cmdbuf is shared memory, validated in place); what differs is that
a torn record surfaces as `EIO` from a throwing typed-array construction
rather than `EINVAL` from a host-side re-check. Not a memory-safety boundary.

**And deliberately not moved: the alignment check.** The deleted table also
refused any float payload whose byte offset was not 4-aligned, because
`new Float32Array(buffer, byteOffset, n)` throws on one. That is a property of
one host language, not of the wire contract — the guest encoder packs records
with no padding (`OP_SHADER_SOURCE` is `8 + strlen(src)`), so misaligned float
tails are *legal output*. The kernel therefore does not check alignment, and
`cda085292` makes the host read such a payload by copying instead of viewing.
Before that pair, a program that uploaded a shader source of non-multiple-of-4
length and set a matrix uniform in the same command buffer lost the whole
submission to `EINVAL`.

### Piece 2 — framebuffer input: NOT MOVABLE, and the grounding's line list is stale

Two corrections to `docs/plans/2026-09-09-rust-first-value-plan.md` §2q.

**The list is out of date.** `injectChunkedMouseMotion` and `clamp` are already
gone — piece 1's partial win moved PS/2 delta splitting into `mouse.rs`. What
is left of the "≈300 lines of computation" is two keycode tables (~270 lines),
three encode functions (~35), and `scalePointerLockMouseDelta` (~22).

**The main-thread blocker is not the real one, and the real one is worse.**
The grounding said migrating the encoding means migrating the input path, with
"real latency consequences". It does not: the main thread already posts to the
kernel worker (`sendInput(bytes)`), so posting `{code, key, pressed}` instead
and encoding in the worker is the *same number of hops*. No round trip.

The actual blocker is that there is nothing in the kernel to inject into.
`kernel_inject_mouse_event` exists because the kernel owns a mouse device —
`/dev/input/mice`, `mouse.rs`. **There is no keyboard device**: `devfs.rs:194`
says so in as many words ("No `/dev/input/eventN` evdev nodes yet"), and the
MEDIUMRAW bytes are delivered as ordinary stdin or PTY writes whose target is
chosen by main-thread routing state (`kernel-host.ts:2271`, PTY vs
`appendStdinData`). Creating that device is the VT-model question
`docs/future-improvements.md` explicitly defers.

And the bulk is not kernel computation anyway. `LINUX_KEYCODE_BY_DOM_CODE` and
`LINUX_KEYCODE_BY_KEY_VALUE` translate a **W3C UI Events** namespace —
`"KeyA"`, `"ArrowUp"` — into Linux keycodes. That is what a scancode-set
driver does with its own hardware namespace. No other host would ever read
those tables; a host-native keyboard would deliver evdev keycodes directly.
Putting them in the kernel makes them dead weight on two of three hosts.

Checked and clean: the two tables do not contradict each other. Every keycode
reachable through the key-value table is also reachable through the code
table, and no keycode has two names in the code table.

**Two findings, neither fixed:**

1. **`KDGKBMODE` reports a mode the byte stream is never in.** `syscalls.rs`
   answers `K_XLATE` (1) unconditionally and `KDSKBMODE` accepts any mode as a
   no-op, while the host encodes MEDIUMRAW unconditionally. A guest that sets
   `K_MEDIUMRAW` and reads the mode back is told `K_XLATE`. Storing the mode
   would move the lie rather than remove it — the honest fix is for the kernel
   to own the encoding, which needs the keyboard device above. **NDD-K11-1.**
2. **The PS/2 Y-axis convention lives in two host call sites.** "Browser Y is
   down, PS/2 Y is up" is applied in `scalePointerLockMouseDelta` and again,
   independently, at `Modeset.tsx:139`. `mouse.rs` owns the packet layout and
   sign bits and is the natural single home — but moving it changes the
   meaning of `kernel_inject_mouse_event`'s `dy` argument, which is an
   ABI-semantic change under a frozen ABI 44. **NDD-K11-2.**

### Piece 4 — TLS/HTTP framing: NOT MOVABLE as scoped, but it paid twice

**The structural reason is not "a `NetworkIO` backend holds no kernel
handle".** `TlsNetworkBackend` is constructed in
`browser-kernel-worker-entry.ts:720`, inside the kernel worker, which has a
kernel instance. The reason is that **the bytes never live in guest memory.**
The request text is produced by the MITM's Web Crypto decryption; the response
arrives inside a `fetch()` `Response`. Both are host-owned.

Verified exhaustively: the kernel has **no route to receive host-owned bytes
for computation.** Every `kernel_*` export taking a pointer takes an offset
into *kernel* linear memory — a wasm function cannot receive a pointer into
another `WebAssembly.Memory` — and `host/src/kernel-scratch.ts` enforces that
with an explicit allowlist of every export permitted to borrow a scratch
lease, plus the argument index of each pointer. The only cross-address-space
byte channel is `host_proc_read_bytes` / `host_proc_write_bytes`, anchored at
a *process* address. Inventing a general "host asks the kernel to compute on
host bytes" channel is the host contract growing, which is the direction V4
forbids.

The coherent end state is therefore larger than a port and is a design
decision, not a migration: guest `send()` → kernel socket → `host_tls_*` →
kernel-owned HTTP proxy → `host_fetch`. That replaces the whole 873-line MITM
backend with imports. **NDD-K11-3.**

Two things were delivered from this piece anyway.

**A fourth dead-floor instance, and the largest single deletion available:**
`packages/registry/openssl/src/tls-fetch-backend.ts` (389) plus
`tls-worker.ts` (529), the checked-in `tls-worker-bundle.js` (2,638) and
`scripts/bundle-tls-worker.sh`. **3,556 lines, zero importers anywhere.** The
only surviving mentions are two 2026-03-14 plan documents naming a class
(`TlsFetchNetworkBackend`) the file does not define. It carried a fourth copy
of the host readiness rule and a third `formatHttpResponse`, so anyone
auditing "how does Kandelo decide a socket is writable" had to read it and
then discover it does not run.

**A live HTTP framing defect, from two copies of one decision.** Both browser
backends carried their own eight framing helpers; six were byte-identical and
two had drifted. Only the TLS copy dropped the origin's `Content-Length`
before appending the one it computes for the `fetch()`-decoded body. So a
guest fetching any gzip-serving origin **over plain HTTP** received two
`Content-Length` field lines with different values — unrecoverable under
RFC 9110 section 8.6. Fixed by extracting `host/src/networking/http1.ts` and
letting the correct copy win; regression test added and observed to produce
exactly one. `parseHttpRequest` had also lost the request-line version in the
plain-HTTP copy, so that backend could not have honoured keep-alive.

### The census finding worth more than any of the line counts

**The socket readiness rule exists five times and the copies disagree.**

| Copy | Location |
|---|---|
| kernel | `syscalls.rs:14604-14757` |
| TLS MITM | `tls-network-backend.ts:822-858` (two rules in one) |
| plain fetch | `fetch-backend.ts:202-224` |
| Node TCP | `tcp-backend.ts:164-187` |
| virtual net | `virtual-network.ts:124-145` |

They are not equivalent. `fetch-backend` reports `POLLOUT` unconditionally;
the TLS arm gates it on `!closed`; `tcp-backend` gates it on five socket
facts; `virtual-network` gates it on the peer. `tcp-backend` sets `POLLHUP`
regardless of the requested `events`, `virtual-network` only inside the
`POLLIN` guard. The `POLLIN/POLLOUT/POLLERR/POLLHUP/MSG_PEEK` constants are
redeclared in all four host files.

The kernel has a complete rule *and* abdicates to the host for exactly these
sockets — `syscalls.rs:14701-14717` calls `host_net_poll` and ORs the answer
in. `MSG_PEEK` is the same shape: implemented correctly in the kernel over its
pipes (`syscalls.rs:12530`, `:14288`, `:18752`) and again in each host backend
over its own buffer. And `host/src/kernel.ts` silently reclassifies errnos the
backends raise — a bare `Error("ENOTCONN")` becomes `-104` (ECONNRESET) at
`:4750` and a send failure `-32` (EPIPE) at `:4713`, neither of which any
backend chose.

**This, not HTTP parsing, is the migratable part of the networking host
surface** — readiness is a POSIX decision the kernel already knows how to
make. It is a larger item than B5 and belongs to whoever opens `socket.rs`
next. **NDD-K11-4.**

### Ledger

Measured with `git diff --numstat`, not estimated. `.ts`/`.tsx`/`.js` on the
left, `.rs` on the right; documentation commits excluded.

| Commit | TS/JS | Rust |
|---|---|---|
| `c69a133a3` piece 3 cutover | **−100** (+39 / −139) | +626 |
| `ae5f5b867` dead Node TLS backend | **−3,556** (+0 / −3,556) | — |
| `5d45bd160` HTTP framing deduped | **+8** (+205 / −197) | — |
| `cda085292` unaligned float payloads | **+64** (+74 / −10) | — |
| **Total** | **−3,584** | **+626** |

Two rows are honestly positive and should not be dressed down. The framing
dedup removes 197 lines of duplicated implementation and puts back a 141-line
shared module — most of that a doc comment explaining why the code is host code
and what the drift cost — plus a regression test. The alignment fix is a bug
fix with a test, not a migration. Both were found *while* doing B5 and belong
to it; neither is ledger progress.

Host import count verified at **75**, unchanged. `abi/snapshot.json` unchanged;
`scripts/check-abi-version.sh` reports the snapshot in sync with sources.

### What was run, and what was not

`cargo test -p runtime-core --target aarch64-apple-darwin`: 1944 passed, 0
failed. `cargo check -p kandelo` (wasm32) and `cargo check --workspace
--target aarch64-apple-darwin`: clean. `scripts/check-abi-version.sh`: snapshot
in sync, no drift, no bump. `npm --prefix host run typecheck`: 0 errors.
Vitest `webgl-bridge` / `webgl-shadow` / `dri-multiplex`: 36 passed. Vitest
`fetch-backend` / `tls-network-backend-real-client`: 39 passed.

**Not run: any browser.** Both networking backends and the framebuffer
controls are browser-only; they belong to the tier-end consolidated pass.
Piece 3's GL path likewise has no guest-level suite — the webgl tests drive a
hand-rolled `WebGL2RenderingContext` stand-in, not a real context.

**The full host Vitest run is not a usable gate in a fresh worktree, and this
is the seventh provisioning surprise the campaign has logged.** After every
documented provisioning step — both sysroots, root and `host` npm installs,
`fork-module/build-wasm.sh`, `./run.sh rebuild kernel` *plus*
`install-local-artifact`, `./run.sh rebuild rootfs`, `build-programs.sh` — the
run was **259 files passed / 131 failed / 37 skipped**. The failures are
environmental, not this item's:

- **203 occurrences of `Could not find repo root (expected workspace
  Cargo.toml + package.json)`**, thrown by `findRepoRoot`
  (`binary-resolver.ts:102`) from inside the *bundled* worker entry. The
  bundle is materialized at `$TMPDIR/kandelo-worker-entry-*/worker-entry.mjs`,
  so `currentModuleDir()` starts in a temp directory and walking up never
  reaches the checkout. `describeWasmArtifactPolicy` calls `findRepoRoot()`
  with no start path, and `WASM_POSIX_BINARY_RESOLVER_REPO_ROOT` is the only
  escape.
- Stale entries in the *shared* `$HOME/.cache/kandelo/programs`, reported as
  `artifact lacks an __abi_version export`.

**Verified pre-existing, not assumed.** `test/audio-integration.test.ts` was
re-run at the base commit `d34e9ed01` with this item's changes absent: 6 of 6
failed identically. This item touches 17 files, none of them
`binary-resolver.ts`, the worker entry, or the bundler.

Targeted suites are therefore the honest evidence, and they are green.

---

## Item B9 — per-process pointer width, registered once

A process's data model is a property of its address space, not of any one
syscall. It used to travel per call, written into channel argument slot 5 by
both the host and the guest's own libc glue on every call that needed a
caller-native layout. That slot is where `preadv2` and `pwritev2` keep `flags`,
so no `RWF_*` value ever reached the kernel: a program asking for `RWF_DSYNC`
got an unsynchronized write and a success return.

`Process` now carries `pointer_width`, established at each point an address
space comes into being: the host registers it through the new
`kernel_set_process_pointer_width` export during `registerProcess`; a `fork`
child inherits it through the fork state record (version **15 → 16**); and an
`exec` replacement is written by the kernel itself inside
`exec_target::finish_commit`, from the artifact bytes the incoming image
committed to, read before the point of no return. No `ABI_VERSION` bump — the
epoch is unreleased. Host import count is unchanged at **75**, verified from
the built kernel's import section with an identical import set.

### The census lesson: twelve readers that named no constant

**This is the finding worth carrying forward.** The first census searched for
`PROCESS_POINTER_WIDTH_ARG_INDEX` and for the `caller_pointer_width!()` macro
— the two names the feature goes by — and was wrong.

**Twelve dispatch arms in `crates/kernel/src/wasm_api.rs` read the caller's
pointer width as a bare `args[5]`, naming no constant at all.** They are the
syscalls whose records are caller-native and so cannot be sized by the kernel's
own target: `statfs`, `fstatfs`, `setitimer`, `getitimer`, `sigaltstack`,
`timer_create`, `rt_sigtimedwait`, `rt_sigqueueinfo`, `sysinfo`, `mq_open`,
the `mq_timedsend`/`mq_timedreceive` attribute path, and `mq_getsetattr`.
Retiring the stamp left every one of them reading the caller's real sixth
argument — almost always zero — as a data model, failing
`ProcessDataModel::from_width` with `EINVAL` for every caller.

**Three more writers were hiding the same way in the guest**, in
`libc/glue/channel_syscall.c`: `kandelo_write_record_header`, the ioctl
special-layout path, and the `KANDELO_WRITE_HEADER` macro each forced slot 5 to
`sizeof(void *)`. All three were keyed on **`si == 5u`**, the slot index, not on
any shared name. Had only the host stopped writing the slot, the guest would
have gone on destroying `flags` in every opaque channel record it emitted.

**How they were found: by sweeping the surviving comments, not the feature.**
A grep for the prose "private sixth channel slot" / "sixth argument" / "slot 5"
across `crates/`, `host/src/`, `libc/` and `tools/` surfaced all of them. The
identifiers had no common substring; the *explanations* did. When a convention
is retired, the comments that describe it are a better index of its readers
than its own name is.

### The guard, and the fact that it was seen to fail

`wasm_api_reads_the_sixth_slot_only_as_the_callers_own_argument`
(`crates/kernel/src/lib.rs`, beside the three existing `wasm_api_source_guards`)
collects every non-comment line in `wasm_api.rs` mentioning `args[5]` and
requires exactly one: the scalar alias `let a6 = args[5] as i32;`, which is the
caller's own sixth argument.

**The guard was verified to fail on the tree immediately before the fix**
(`7d3c935de`), where it collects **thirteen** lines — the alias plus all twelve
offenders. A guard that has never been seen to fail is not yet known to be a
guard; this one has been.

### preadv2/pwritev2 flags

With the slot returned to its owner,
`wasm_posix_shared::rwf_flags::check_rwf_flags` implements `RWF_NOWAIT` (it
suppresses the blocking retry a would-block transfer parks on) and refuses every
other `RWF_*` bit with `EOPNOTSUPP` rather than ignoring it, as Linux does. Slot
5 of both calls is newly declared `ChannelScalarKind::U32` in the channel scalar
contract. **musl and everything linked against it must be rebuilt**, because the
guest side of the contract changed.

Known, pre-existing, not a regression: `crates/host-native` honours neither
`RWF_NOWAIT` nor `MSG_DONTWAIT`'s no-park behaviour. This change makes the flag
*reachable* where it was previously destroyed for everyone; the TypeScript host
honours it exactly as it already honours `MSG_DONTWAIT`.

### What was run, and what was not

Under `scripts/dev-shell.sh`, with an isolated `KANDELO_SOURCE_CACHE_ROOT`
verified from inside the shell:

- `cargo test --target aarch64-apple-darwin` for `runtime-core` (1952),
  `wasm-posix-shared` (77), `kandelo` (4 source guards + 4 integration),
  `wasm-artifact` (19), `host-native` (54 + 1, driving real guests against the
  rebuilt `kernel.wasm`): all pass.
- `dump-abi --check`: snapshot, all seven generated musl headers and the TS
  bindings in sync, no drift, no bump. The snapshot delta is exactly three
  entries — slot 5 of `preadv2`, slot 5 of `pwritev2`, and the
  `kernel_set_process_pointer_width` export.
- `npm run typecheck` from `host/`: 0 errors.
- Targeted Vitest from `host/`: `kernel-process-registration-entry` 9/9,
  plus `host-process-pointer-width`, `channel-scalar-contract` and
  `generated-abi`.

**Not run: the full host Vitest, and no browser.** Three attempts were each
invalidated before producing a usable number — one killed by resource
exhaustion, one whose global setup lost a race with a concurrent `cargo`
invocation over the program-index transaction, and one that began before
`fork_module32.wasm` had been built. A fourth was still inside global setup when
this was written. **No full-suite number is claimed.**

Two failures seen during those attempts are the provisioning shape this document
already records above: `Could not find repo root (expected workspace Cargo.toml
+ package.json)` thrown by `findRepoRoot` from a bundled worker entry in a temp
directory. That has since been root-caused elsewhere — the commit retiring the
TypeScript WebAssembly reader left three Node entry points without an artifact
reader, one of them `host/dist`'s own build, so `host/dist` never existed — and
a fourth realm, the Vite dev server, was fixed separately. This item is based on
`0ab2ccf3e`, which predates those fixes, so failures of that shape here are
neither this item's nor real.

**Pre-existing, verified rather than assumed.** `kernel-scratch-contract`
(2 failures: a `#sysvMirrorExports` context-return, and a duplicate
`dylink-planner` audit allowance) and `abi-version` were run at the base commit
`0ab2ccf3e` with this item's changes absent and failed identically there.

### Collision surface

`host/src/process-lifecycle.ts` and `tools/xtask/src/local_build.rs` are
untouched. `crates/runtime-core/src/process.rs` takes two hunks — one struct
field after `secure_exec`, one initializer — and no `sys_clone` or thread-slot
code. `crates/runtime-core/src/syscalls.rs` takes one hunk, tests only, appended
inside the existing `mod tests`.

---

## The exit-144 host-Vitest "flake" is not the suite

Five full host Vitest attempts ended in `exit code 144` during item B9, and
the first report of that — "roughly a coin flip to survive" — framed it as a
ship-gate problem. **That framing was wrong, and the correction matters: the
gate is probably fine, and the unreliability is in how agents drive it.**

### What it is not

**Not Vitest, not Node, not Nix, not memory.** Two of the tasks that exited 144
contained none of them. They were pure Bash:

```
until grep -aq "Test Files" "$F"; do sleep 20; done
```

No child process beyond `sleep` and `grep`, no Wasm, no worker threads. Both
produced **zero bytes of output** and both ended `[exited with code 144]`. A
watchdog inside Vitest's pool, a Node OOM, a Nix substituter failure and system
memory pressure are all excluded by that one observation: none of them can
reach an idle `sleep` loop.

Supporting measurements taken while the kills were happening: system memory
**73% free**; user process count **703** against a `kern.maxprocperuid` of
**8000**; file-descriptor limit 1048576. No resource was near exhaustion.

### What the pattern is

| attempt | fate |
|---|---|
| full run, 11558 lines | **completed** — 105 failed / 257 passed / 65 skipped |
| baseline run, 10801 lines | **completed** — 103 failed / 259 passed / 65 skipped |
| full run | global-setup failure, exit 0 — caused by a concurrent `cargo` of mine racing the program-index transaction |
| full run | killed 144 |
| full run, ~5 min in | killed 144 |
| full run, <1 min in | killed 144 |

The kills **cluster in time**. One run died about five minutes in and a Bash
waiter died in the same window; a new background task started a minute later
died almost immediately, and a trivial probe started three minutes after that
survived. That is the shape of an external, transient, session-level event
reaping background tasks — not a workload crossing a threshold.

**Not a fixed lifetime cap either.** The two runs that completed each ran about
half an hour. And a deliberate control — an idle `sleep` loop emitting one line
every fifteen seconds, started in the same session minutes after the kills —
ran the full ten minutes and exited 0. So neither age nor idleness explains
which tasks were reaped.

### What was NOT determined

**The trigger was not identified.** It is a background-task termination in the
agent harness, and nothing in this repository can observe why the harness chose
to send it. This is recorded as an honestly-labelled unknown rather than a
plausible story, because the plausible stories — pool watchdog, OOM, contention
— are the ones the evidence above already rules out.

### What this means for the gate

**Every run that was not externally killed, finished.** Two produced complete
results in about 24 minutes of test time each; the third failed in global setup
for a reason that was diagnosed and is reproducible-on-demand (a concurrent
`cargo` invocation and the program-index transaction are not safe together).
The suite itself did not once fail to complete on its own merits.

So the operational guidance for anyone driving this suite, agent or human:

1. **Run it with nothing else touching `cargo`.** The global setup shells out to
   `cargo run -p xtask -- build-deps program-index`; a concurrent `cargo` in the
   same checkout makes that step fail and takes the whole run with it. This
   accounted for one of the six attempts.
2. **Do not treat a 144 as a suite failure.** It carries no test information at
   all. Re-run it.
3. **Budget about 25 minutes of test time**, plus a global setup that builds
   program fixtures on a cold worktree.

A gate that needs a retry loop is worse than one that does not, but it is a
different and much smaller problem than a suite that cannot complete.
