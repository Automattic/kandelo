# Unscoped-lane survey — what the OWED-WORK REGISTER does not track

**Date:** 2026-09-11. **Worktree:**
`.claude/worktrees/agent-ad820fa8ec1805a90`, base `4bdec312b`
(`origin/brandonpayton/epoll-kernel-route`).

**This is a survey. No production code was written, and nothing found
here was fixed.**

## Why

A maintainer question produced an uncomfortable answer: the fork-related
TypeScript this campaign set out to migrate and delete has *grown*,
against a contract that says it "shrinks toward the floor over time; it
does not grow." A separate lane is scoping that one.

The question this document answers is the follow-on: **is that an
isolated embarrassment, or a class?** The OWED-WORK REGISTER tracks 39
rows in section B plus 9 in section A. A register is only as good as the
sweep that filled it, and this campaign has already been burned twice by
censuses that undercounted — the worker-entry pairs were 21 and not 16,
the pointer-width sites were 17 and not 0.

So this is a census of what nobody is doing: bodies of work the
campaign's own four goals imply should exist, which no register row
covers, and which have no owner.

For reference, those goals in the maintainer's framing are **V1** share
code across hosts, **V2** deeper Rust type checking, **V3** bundle the
kernel with the VFS so ABI changes cannot break images, and **V4** — the
primary one — minimize the host API surface so a new host is cheap to
write.

## Premises verified before anything was built on them

The brief that commissioned this survey carried six numbers. They were
checked first, because this campaign's most expensive hours have all
gone to confident wrong answers.

| premise as given | measured | verdict |
|---|---|---|
| Base is the campaign merge-base `9195dedd1` | it was | **TRUE, and corrected.** This worktree was handed `9195dedd1`, **1,093 commits** behind `origin/brandonpayton/epoll-kernel-route`. Reset to `4bdec312b` before any measurement. That makes **eleven** agents caught by this dispatch defect, not seven |
| Fork TS grew 28 → 38 files, 23,246 → 26,113 lines | 28 → **39** files, 25,398 → **26,128** lines (any `fork` in the path); 25 → 36 files, 22,725 → 25,592 lines (`fork-` basename prefix) | **DIRECTION AND MAGNITUDE HOLD.** Both filters give ~+11 files and ~+2,900 lines. The brief's base figure of 23,246 matches neither filter exactly; the head figure is within 15 lines of the prefix-filtered count. Quote "+11 files, ~+2,900 lines" and say which filter |
| `worker-main.ts` +1,453 | 6,083 → 7,536 = **+1,453** | **EXACT** |
| Host import floor = 72 functions + `env.memory` (73 entries) | **72 functions**, enumerated from the single `#[link(wasm_import_module = "env")]` block at `crates/kernel/src/wasm_api.rs:56-310`; `env.memory` imported via `--import-memory` | **TRUE.** No built `kernel.wasm` exists in this worktree, so this is a source enumeration, not an artifact measurement — see "What I did NOT look at". `EXPECTED_HOST_IMPORT_COUNT = 72` (`crates/host-native/src/lib.rs:214`) was derived *after* the independent count and agrees, so the pin is not stale today |
| Register has 38 items | 39 rows in section B, 9 in section A | **CLOSE ENOUGH**; the survey cross-checked against all 48 |
| `st_rdev` is zero-filled for every device node | see lane U6 below | **verified** |

One premise of my own that I disproved, and it changed a finding: I was
about to file "`MountConfig.readonly` is never read anywhere" on the
strength of a clean grep of `vfs.ts`. A wider grep found
`memory-fs.ts:8411` reading it. Reading that site showed it is a
*validation* inside a separate mechanism, not a write gate — so the
finding survives, but in a narrower and more accurate form (U3 below). A
grep that returns what you expect is the most dangerous grep on the
screen.

## Method, and where it is weak

Four habits, each of which this campaign has paid for:

1. **Transitive caller censuses, not direct greps.** A direct grep gave
   an agent 13 false alarms this week because most call sites reach
   their target indirectly — through a trait object, a `pub use`, a
   dispatch table keyed by syscall number, or a `#[no_mangle]` symbol
   consumed from TypeScript. Every "dead" claim below names the census
   that establishes it.
2. **Every zero re-run with a known-positive control.** A sweep in this
   campaign once reported zero problems when the true answer was 441,
   because a shell quoting bug made the pattern match everything. It
   looked exactly like a clean bill of health from a check that never
   ran. Each zero below states its control.
3. **A file's name is not its category.** `binary-resolver.ts` reads
   like build tooling and is on the Node runtime path;
   `sharedfs-vendor.ts` reads like a vendored dependency and is a
   filesystem implementation.
4. **The three highest-ranked findings were re-verified at source by me,
   not taken from the sweep that produced them.** `host-native`'s `move
   |_c, _clock_id: i32, sec_ptr, nsec_ptr|` returning
`SystemTime::now()` — confirmed at
`crates/host-native/src/guest.rs:2707`. `pub fn sys_waitpid(_proc: &mut
Process, host: &mut dyn HostIO, …)` whose entire body is
`host.host_waitpid(pid, options)` — confirmed at
`crates/runtime-core/src/syscalls.rs:19045`. The xattr contradiction —
confirmed on both sides (`wasm_api.rs:6854,6859,6863` return 0 with the
comment `silently accept`; `docs/posix-status.md:390-392` says "Returns
ENOSYS" three times). **One citation was wrong and is corrected in
place**: the sweep gave the xattr location as "wasm_api.rs:350-361",
which are the *syscall numbers*, not line numbers. Everything else in
this document that came from a sweep is cited as that sweep gave it, and
has **not** been independently re-verified by me.

The weakness worth stating plainly: this is a **structural** survey. It
reads code and traces callers. It ran no tests, no builds, and no
browser — by instruction and by budget. So every claim here is a claim
about the *shape* of the tree, and none of it is validated by execution.

## Candidate lanes

Ranked by value in the section after this one. "Register" says whether
an existing row already covers it — the instruction was to prefer
reporting "already tracked as B12" over filing twice. **Four candidates
were dropped during that cross-check and are named here so nobody
re-derives them:** `host/src/networking` and `host/src/framebuffer` (B5,
closed, with pieces 2 and 4 ruled immovable for stated structural
reasons); the 30 "ABI 43" message strings in `host/src` (already an open
register entry, and deliberately not a mechanical sweep); the `epoll`
host mirror (B6, closed); and `host/src/audio`, which turned out not to
be a finding at all — see the negative result at the end of the evidence
section, which is worth more than a candidate would have been.

| # | Lane | Goal | Size | Blocked by | Register cross-check |
|---|---|---|---|---|---|
| U1 | The SFFS block filesystem exists twice — once in TypeScript, once in Rust — and only the 318-line tail of the TypeScript half is scheduled for deletion | V1, V3, V4 | **12,198 lines** (`memory-fs.ts` 8,446 + `sharedfs-vendor.ts` 3,752), of which ~600 is genuine host floor | W-3 streaming emission, then exposing the kernel writer to ~40 `images/vfs/scripts/` build consumers | **PARTIAL — this is the finding.** Lane C's W-2 (Rust writer) is landed and wired; W-4's stated deliverable is "delete `rootfs-overlay-export.ts`, drop `entries[]`" = 318 lines. **No row names the other 11,880** |
| U2 | `web-libs/kandelo-session` reports the *requested* boot descriptor as the machine's state, and carries behavioural fallbacks for ABI epochs 35 versions stale | V4, Browser-and-User, Platform-Values | ~2,776 lines in one file; the defects are ~6 sites | nothing — these are small, independent, and local | **NOT TRACKED.** The only register row touching `web-libs` is NDD-BOOT-1 (`boot-descriptor.ts`, 507 lines, not started). Adjacent to but distinct from "Stale ABI epochs in user-facing messages", which is scoped to **message strings in `host/src`**; these are **behavioural branches in `web-libs`** |
| U3 | `MountConfig.readonly` and 7 of 12 `MountSource` kinds are declared, validated, rendered to the user, and honoured by nothing | Browser-and-User, Platform-Values | small — ~40 lines to make honest | nothing | **NOT TRACKED.** Same family as B35 (`st_rdev`) but in the browser mount contract rather than the syscall ABI |
| U4 | Dead floors in Rust beyond `shared_mapping_policy.rs` — **five more**, plus six test-only public APIs. The largest is a fork decoder whose **live twin is TypeScript** | V2 | ~900 dead production lines across 5 modules | nothing | **NOT TRACKED.** `shared_mapping_policy.rs` (B2/B3), `wait_queue.rs`/`wait_shadow.rs` (B8) and the K7 SysV Rust were excluded as already tracked. **U4b overlaps the fork lane** — flagged, not claimed |
| U5 | Duplicated authority — **17 more**, bringing the campaign total to 28. **Three already disagree**, one of them making `CLOCK_MONOTONIC` non-monotonic on the conformance host | V1, V2 | ~2,400 lines removable; the three live defects are ~60 lines to fix | nothing | **NOT TRACKED.** Cross-checked against all eleven prior instances and all 48 register rows |
| U6 | Declared-but-unimplemented platform surface — **16 more**, of which **four contradict `docs/posix-status.md`**, which says ENOSYS where the code returns success | Platform-Values | 16 sites; individually small | nothing | **B35 is one instance and is the best-behaved member of its family** — it is honest in code. These are not. The *structural* half (a population gate in `abi/snapshot.json`) is distinct from B34's open offset-guard half |
| U7 | 10 host imports where the host *decides* and 17 where the import's shape is wrong | **V4, the primary goal** | 27 of 72 imports | ABI 44 is one unreleased epoch, so retirement is cheap now and costs an epoch later | **NOT TRACKED as a lane.** The register's ship gate defers "the ~9,900-line driver-glue audit" to campaign two; that is the *glue*, not the *import list*. The import list is the metric the campaign says it is optimising, and nothing schedules work against it |
| U8 | ~1,700 lines of test-authority scaffolding inside production `kernel-worker.ts` / `kernel.ts`, counted by the campaign's own headline metric | metric hygiene | ~1,671 lines | nothing | **NOT TRACKED.** T4 is "test residue" in `host/test`, a different place |

## Evidence

### U1 — one block filesystem, two implementations, and the deletion stops 318 lines in

This is the largest single finding in the survey, and it is not a
suspicion: **the Rust side says so in its own doc comment.**

`crates/runtime-core/src/sffs_write.rs:1-21`:

> `sffs.rs` is the reader this repository already trusts … This module
> is its inverse — it BUILDS that body from a tree, so the kernel can
> emit a VFS image without a TypeScript writer in the loop. … the layout
> decisions here are not free: **they reproduce
> `host/src/vfs/sharedfs-vendor.ts`** — the same superblock geometry,
> the same first-fit block and inode allocators, the same ext2-style
> variable-length directory records with padding entries and `rec_len`
> extension, and the same threshold above which that file's in-process
> directory index changes where a new record lands.

**Both halves named, as required.**

| | TypeScript | Rust |
|---|---|---|
| format | `host/src/vfs/sharedfs-vendor.ts` (3,752) — "A block-based filesystem on SharedArrayBuffer … Layout (same as the C implementation): Superblock, FD table, inode bitmap, block bitmap, inode table, data blocks" | `crates/runtime-core/src/sffs.rs` (reader) + `crates/runtime-core/src/sffs_write.rs` (2,387, writer) |
| magic | `sharedfs-vendor.ts:36` `MAGIC = 0x53464653` | `sffs.rs:206` `SFFS_MAGIC = 0x5346_4653` |
| geometry | `BLOCK_SIZE 4096`, `INODE_SIZE 128`, `INODES_PER_BLOCK 32`, `MAX_NAME 255`, `MAX_SYMLINK_HOPS 8` | `sffs.rs:208-213` — identical |
| image + lazy layer | `host/src/vfs/memory-fs.ts` (8,446) — VFSI container, zstd frame bounding, lazy trees, atomic-group seals, materialization plans, identity reconciliation, plus a 30-method `FileSystemBackend` | `sffs.rs:19` `VFSI_MAGIC`, `rootfs.rs`, `sffs_deferred.rs`, `klzy.rs` |

**They AGREE today** — deliberately, because the cross-language fixture
is a byte comparison. That is the strongest possible form of this
finding rather than the weakest: the duplication is *known, intentional,
and complete*, and under the campaign's own rule — "**Cutover is part of
the item. An item is done when the Rust runs and the superseded
TypeScript is deleted. Landing tested-but-dormant Rust is a failed
item**" — a landed byte-identical Rust writer with the TypeScript still
live is the definition of an unfinished item.

**The boundary between what lane C covers and what it does not, traced
rather than assumed.** The Rust writer is not merely landed, it is
*exported and live*: `crates/kernel/src/wasm_api.rs:2267`
`kernel_rootfs_export_tree` (production, well before the `#[cfg(test)]`
at `rootfs.rs:3716`) is called from `host/src/kernel-worker.ts:5493` and
`host/src/kernel-scratch.ts:169,281,375`, and consumed by
`host/src/vfs/rootfs-overlay-export.ts`. Control: a grep for a
known-live export, `kernel_rootfs_set_foreign_mount_roots`, returns 5
production hits over the same corpus.

So lane C's chain is real and its endpoint is exact — **W-4 deletes the
318-line consumer of an export that already works.** What it does not
touch is the *other* consumer of the same format: `MemoryFileSystem` as
the **image builder** for every product image in the repo, which is
where the 12,198 lines live. Two consumers, one format, one of them
scheduled.

**Why the register does not cover it.** Lane C is `W-2 → W-3 → W-4`. W-2
is the writer and is landed and reached:
`crates/runtime-core/src/rootfs.rs` uses `sffs_write::{SffsImage,
SffsWriter, SffsConfig, Content, ContentSource}` at lines 3281,
3300-3305, 3420, 3454, 3702. W-4's deliverable, quoted from the
register, is "Cut over, delete `rootfs-overlay-export.ts`, drop
`entries[]`" — `rootfs-overlay-export.ts` is **318 lines**. Nothing in
the register names `memory-fs.ts` or `sharedfs-vendor.ts`.

**What the 12,198 lines actually are**, because "delete the VFS" is not
the recommendation and the split matters:

- **~600 lines are genuine host floor** — `fetchLazyBytes` (191) and the
  lazy transport/retry/abort machinery around it are network access,
  which only a host can perform.
- **~560 lines are the `FileSystemBackend` POSIX surface**
  (`memory-fs.ts:7626` `open` through `:8186` `closedir`:
  `open`/`read`/`write`/`stat`/`mkdir`/`rename`/`link`/`symlink`/
  `chmod`/`chown`/`opendir`/`readdir`/…). This is **still live but on a
  much smaller path than its size suggests**: both hosts now drop `/`
  from the guest-facing router.
  `host/src/browser-kernel-worker-entry.ts:802` and
  `host/src/node-kernel-worker-entry.ts:844` both compute
  `mounts.filter((m) => m.mountPoint !== "/")`, and the comment explains
  the backing `MemoryFileSystem` "stays alive as the `blob_read` byte
  store and lazy-group source even though it is no longer mounted." What
  still routes through it is `/dev/shm` and non-tmpfs scratch such as
  `/run`.
- **the remaining ~11,000 lines are format, validation, lazy-tree and
  identity logic** — deterministic computation over bytes, in the
  language with no types over them. This is the part the campaign's own
  reclassification of `constants.ts` already ruled on: "it touches no
  host object; its input is an `ArrayBuffer` … Reclassify: **MIGRATE**."

**The blocker, stated honestly.** `MemoryFileSystem` has ~40 importers
under `images/vfs/scripts/` — it is the image *builder* for every
product image in the repo, not only a runtime backend. Retiring it needs
the kernel writer reachable from the build toolchain, which is what W-3
(streaming emission, because `lamp.vfs` is 249 MiB and cannot be
buffered in linear memory) exists to enable. So this is not a lane that
can start today; it is a lane whose prerequisite is already scheduled
and whose payload nobody has named.

**The corollary that decides its ranking:** on the register's own
surface-aware ordering, this is the largest V4 item on the board that is
not a fork item. Retiring the TypeScript image writer removes an entire
*category* from what a second host must reimplement — not an import, a
filesystem.

### U2 — the browser session library reports what was asked for, not what is

`web-libs/kandelo-session/src/kernel-host.ts`, 2,776 lines. In the
ledger's scope (`scripts/migration-ledger.sh:31`: `TS_PATHS=(host/src
web-libs/kandelo-session/src)`). The only register row anywhere in this
package is NDD-BOOT-1, which covers a different file and has not
started.

**U2a — `getMounts()` returns the boot descriptor, and the kernel path
is unreachable for any bootable machine.** `kernel-host.ts:2018-2028`:

```
// Mounts are configured at boot time from the BootDescriptor; the
// kernel doesn't grow new mounts dynamically. Source-of-truth is
// descriptor.mounts. If a future kernel adds runtime mount/umount
// syscalls and exposes /proc/mounts, the catch falls through to
// the kernel view.
const fromDesc = descriptorMountsToInfo(this._descriptor.mounts);
if (fromDesc.length > 0) return fromDesc;
const text = await this.readFileText("/proc/mounts").catch(() => "");
return parseMounts(text);
```

**The premise in that comment is stale.** The kernel already exposes
`/proc/mounts`, `/proc/<pid>/mounts` and `/proc/<pid>/mountinfo` —
`crates/runtime-core/src/procfs.rs:52,56,57` declare
`ProcfsEntry::{Mounts, PidMounts, PidMountinfo}`, and `procfs.rs:1445`
generates real `mountinfo` content.

**Caller census for the unreachable half, with a correction I had to
make to my own claim.** `parseMounts` (defined `kernel-host.ts:2761`)
has **exactly one call site in the entire repo**, line 2027, and that
line is reachable only when the descriptor has **zero** mounts.

I was about to file it as flatly dead on the reasoning that the
validator requires a root image mount. **It does not.**
`boot-descriptor.ts:185-193` requires only that `mounts` is an array
within the 32-mount cap, and the `hasRootImage` check at `:322` fires
only when `packageLayerCount > 0`. So an empty `mounts` array validates,
and `parseMounts` is **not provably dead**.

What is true is weaker and still sufficient: **for every descriptor that
mounts anything at all — which is every descriptor that can boot, since
a machine with no mounts has no root filesystem to exec from — the
kernel branch never runs.** The Inspector pane at
`apps/browser-demos/pages/kandelo/panes/Inspector.tsx:603` therefore
shows the *request* rather than the machine in every reachable case, and
the fallback that would show the machine is reachable only in a state
where there is no machine to show.

**This is production UI, not a dev-only pane** — `Inspector` is rendered
from `apps/browser-demos/pages/kandelo/app/App.tsx:429` and
`views/MachineView.tsx:261`.

Control for the zero: the same grep across `web-libs`, `apps` and `host`
found `parseMaps` (the sibling function) with live callers at
`kernel-host.ts:2011,2015`, so the search mechanism works.

This is the Browser-and-User contract's first sentence — "The browser UI
is a consumer and presentation layer for the platform. It should expose
the real state of a Kandelo machine, not synthesize success" — and it is
one `if` away from being satisfied by code that already exists on both
sides.

**U2b — behavioural fallbacks for ABI epochs that cannot exist.**
`kernel-host.ts:1978-1983`:

> Prefer the direct kernel snapshot (kernel_enum_procs). Falls back to
> walking /proc only when an older kernel is wrapped — **the fallback
> sees no procfs entries unless the static rootfs has them, so it's
> mostly a no-op.** The fast path lands when both this kandelo-session
> version and the kernel ship together (**ABI ≥ 9**).

The epoch is **44**. Two more of the same shape: `kernel-host.ts:249`
("Returns an empty array if the kernel doesn't expose
`kernel_enum_procs` yet (older ABI)") and `:700` ("Returns null when the
wrapped kernel does not yet expose `kmsAttachCanvas` (older ABI …)").
The ABI contract's rule is explicit: "Do not add compatibility shims for
stale ABI artifacts unless the compatibility boundary is explicit,
documented, and intentionally supported … ABI-mismatched VFS images
should fail loudly." These fail **silently, into an empty list**, which
is the worse half of the failure.

**Distinct from the register's "Stale ABI epochs in user-facing
messages".** That row is scoped to 30 *message strings* naming "ABI 43"
in `host/src`, and its note says the sweep must not be mechanical
because some strings are historical statements that are still true.
These are *behavioural branches* in `web-libs`, and the same caution
does not apply: a branch conditioned on an ABI-9 kernel is not a
historical statement, it is unreachable code with a silent-empty failure
mode.

**U2c — `getKernelState()` probes six procfs paths the kernel does not
have.** `kernel-host.ts:2031-2047` probes `/proc/sys/kernel/hostname`,
`/proc/version`, `/proc/sys/kernel/osrelease`,
`/proc/sys/kernel/pid_max`, `/proc/sys/kernel/threads-max`,
`/proc/sys/fs/file-max`. The `ProcfsEntry` enum (`procfs.rs:49-77`) has
**no `/proc/sys` subtree and no `/proc/version`**; grep for `proc/sys`
across all of `crates/` returns zero, controlled against 87 hits for
`proc/` in `procfs.rs` alone. So the pane is empty by construction.

I rank this one **low and I am not filing it as a defect**: the code
catches and skips with a comment saying "Once the kernel grows the
/proc/sys tree, more rows show up automatically," which is honest. The
finding worth keeping is the *platform* half — `/proc/sys/*`,
`/proc/version`, `/proc/meminfo`, `/proc/cpuinfo`, `/proc/uptime` and
`/proc/loadavg` do not exist, and real software reads them. Whether that
is documented in `docs/posix-status.md` I did not fully establish; see
the blind spots.

### U3 — mount attributes that are declared, validated, rendered, and honoured by nothing

**`readonly`.** `web-libs/kandelo-session/src/kernel-host.ts:303` puts
`readonly?: boolean` on `DescriptorMount` — part of the **boot
descriptor**, which the Browser-and-User contract names as untrusted,
shareable input requiring "loud failures".
`host/src/vfs/default-mounts.ts:8-10` states the truth in its own
header:

> `readonly` is currently advisory: `VirtualPlatformIO` does not enforce
> it on writes. The resolver still propagates the flag for backends and
> routers that choose to enforce it.

Verified, with the correction my own premise-check forced. A repo-wide
grep for `.readonly` reads (excluding the TypeScript `readonly`
modifier) finds **propagation only** — `default-mounts.ts:235,249`,
`default-mounts-node.ts:94,109`, `node-kernel-worker-entry.ts:795`,
`product-mount-contract.ts:26` — plus **one** real read at
`memory-fs.ts:8411`. Reading that site: it is inside
`resolveSetIdCapability` and validates that a `trusted-root-product`
set-ID capability is not requested on a writable mount. It is not a
write gate. The only EROFS enforcement in the host VFS
(`memory-fs.ts:8282` `immutableProductReadonlyFailure`) belongs to a
separate `immutableProductBackends` WeakSet mechanism that a descriptor
cannot reach — see U4a, where that mechanism turns out to be dead.

Control for the zero: `.nosuid` over the same corpus returns 27
production reads, including real enforcement at
`vfs.ts:275-277,449-451`.

**Blast radius.** `kernel-host.ts:2721-2722` renders `ro` in the
Inspector's mount options whenever `m.readonly` is set. So a shared URL
can declare a mount read-only, the platform will write to it, and the UI
will tell the user it is read-only. Production uses of `readonly: true`
exist today at `scripts/run-php-upstream-tests.ts:1112,1117`.

**`MountSource`.** `kernel-host.ts:290-293` declares **twelve** kinds,
and `boot-descriptor.ts:41-45` allow-lists **all twelve** as valid
descriptor input.

Enumerating every occurrence of each literal across `host/src`,
`web-libs` and `apps/browser-demos`, excluding tests, gives an unusually
clean result: **`lazy-http`, `cas` and `device` each appear in exactly
four places, and every one of the four is a declaration.** For `cas`:
the union type (`kernel-host.ts:293`), the allow-list
(`boot-descriptor.ts:43`), the display switch (`kernel-host.ts:2746`),
and `apps/browser-demos/pages/kandelo/views/Config.tsx:24` — **a
dropdown that offers it to the user as a selectable mount source.** The
`git`, `archive` and `encrypted` kinds follow the same pattern;
`archive`'s higher raw count is unrelated hits on the ordinary English
word, which is why the count alone was not trusted. **There is no
materialization for any of the six.**

What a descriptor declaring one of them gets is not a refusal. It gets
`fsForMountSource` (`kernel-host.ts:2735-2750`), a **total** switch that
returns `"lazyfs"`, `"archivefs"`, `"gitfs"`, `"casfs"`, `"cryptfs"`,
`"devfs"` — so the Inspector displays a filesystem type for a backend
that does not exist, for a source the configuration form offered.

This is the `st_rdev` shape (B35) moved into the browser contract: a
field the platform declares, a validator that accepts it, a renderer
that displays it, and no implementation behind it. B35's framing applies
word for word — a program (here, a person) "gets a plausible wrong
answer rather than a refusal."

### U4 — dead floors: five more in Rust, and the largest one has a live TypeScript twin

A census of all **196** `.rs` files under `crates/` (130 module files,
17 crate roots, 45 test files, 4 fuzz targets). **130/130 module files
went through an automated per-public-symbol external-reference pass; ~48
were then hand-verified transitively** — trait impls, `pub use`
aliasing, `#[no_mangle]`/`extern "C"` reaching `host/src`, dispatch
tables, `tools/xtask` generators, TypeScript twins, the Cargo dep graph,
and the co-resident-module build list in `local_build.rs`.

**The automated metric alone is not sufficient and was not relied on for
any finding.** Calibration: `module_state_records.rs` scores 16 of 16
symbols referenced — apparently fully live — purely because
`fork-codec/src/lib.rs` re-exports every one of them. The known dead
floor `shared_mapping_policy.rs` scores 1 of 8, which set the baseline.
Both numbers are artefacts of re-export structure, not reachability.

**A method correction that produced a false alarm and is worth
inheriting.** The census's first search path set was `crates host libc
images scripts sdk` and **omitted `tools/`**. That scored
`shared::host_raw_syscalls::host_raw_syscalls_sorted` as DEAD when it is
in fact the source of truth `tools/xtask/src/dump_abi.rs` uses to
generate `host/src/generated/abi.ts`'s `HOST_RAW_SYSCALLS`. Every
finding below was re-run repo-wide including `tools/`. **A
generated-code pipeline is a caller, and it is the one a path list
forgets.**

**U4b — `crates/fork-codec/src/module_state_records.rs`: ~483 of 528
production lines are dead, and the live implementation is TypeScript.**
1,087 lines total, `#[cfg(test)]` at 529. It decodes the per-record-kind
payloads of the fork module-state (KFMS) arena: module template records,
mutable-global snapshots, table descriptors, sparse table pages, element
and data segment bitmaps.

Caller census: of its **16 public symbols, exactly one** —
`decode_journal_image` (L170-214) — is reached outside the file, by
`crates/fork-module/src/lib.rs:2899`. A repo-wide `grep -w` (excluding
`target`, `node_modules`, `docs`) for `decode_record_payload`,
`decode_table_page`, `decode_module_record`, `decode_table_descriptor`,
`decode_element_segments`, `decode_data_segments`,
`decode_mutable_global` and `record_payload_bytes` returns **only**
their own definitions, their own in-file tests, and the three `pub use`
lines at `fork-codec/src/lib.rs:91-93`. `decode_record_payload` (L500)
is the aggregating entry point and nothing calls it.
`fork-module/src/lib.rs` touches `record.kind` in three places and
matches exactly one kind, `JOURNAL_IMAGE`. Control for the zeros:
`decode_journal_image` run through the identical command shape returns
`fork-module/src/lib.rs`.

**What is doing the work instead is `host/src/fork-module-state.ts`
(3,860 lines)**, which defines `decodeModulePayload`,
`decodeTableDescriptor`, `decodeTablePage`, `decodeSegmentBitmap` and
`decodeForkGlobalSnapshot`, and is imported by `host/src/worker-main.ts`
and nine other modules.

Added 2026-08-31 (`05bfcad3b`); unwired for 11 days. **Possibly
DORMANT-BY-DESIGN**: the module's own doc says the live halves are
"DEFERRED to the co-resident module (Phase 6 D5+)". But no declared
in-flight item lands it, and the shape is identical to
`shared_mapping_policy.rs` — which was also well-formed, also tested,
and also never ran.

**This one overlaps the fork lane and I am flagging rather than claiming
it.** It is the campaign's thesis running backwards inside its own
flagship subsystem: the Rust decoder is dead and the TypeScript twin is
production. Whoever scopes the fork-TypeScript growth should be handed
this, because "the TypeScript grew" and "the Rust that was supposed to
replace it never ran" are very likely the same finding seen from two
ends.

**U4c — `crates/fork-codec/src/reference_recipes.rs`, decoder half: ~180
production lines dead.** The *types* are live — `ReferenceRecipeNode`,
`ReferenceRecipeEntry` and `node_edges` are used by 9, 7 and 4
production files respectively (`drive_plan.rs`, `reference_replay.rs`,
`reference_transaction.rs`, `reference_feed.rs`,
`reference_segments_writer.rs`, `drive_plan_hints.rs`,
`reference_graph_builder.rs`). The **decoder** is not:
`decode_reference_recipes` (L422-505), its validator
`validate_reachability` (L392-420) and the container `ReferenceRecipes`
(L179) appear repo-wide only in their own file plus
`fork-codec/src/lib.rs:100`. The live decode path is
`reference_transaction::decode_segmented_reference_transaction`, which
reuses the node types but not this decoder.

**U4d — `crates/fork-codec/src/catalogs.rs`, resume half: ~80 production
lines dead — and it is also a triplication.** The static-root half is
genuinely live, reaching production through
`crates/wasm-artifact/src/fork_contract.rs:571` → `policy.rs:202` →
`kernel/src/wasm_api.rs:3985` (`#[no_mangle]
kernel_exec_target_artifact_policy`) → `host/src/kernel-worker.ts:8779`
and `host/src/kernel-scratch.ts:143`. The resume half —
`decode_resume_catalog` (L160), `ForkResumeCatalog` (L146),
`ForkResumeCatalogRecord` — appears only in its own file and
`lib.rs:66-67`.

**The automated pass scored `ForkResumeCatalogRecord` as live in three
files, and reading cleared it into something worse:**
`crates/host-native/src/guest.rs:4807` declares its **own private**
`struct ForkResumeCatalogRecord` with its own
`read_fork_resume_catalog_records` (L4825), and
`host/src/fork-resume-catalog.ts:12` is a **third** independent copy. So
the fork resume catalog has three implementations and the `fork-codec`
one — the only one in the crate whose job this is — is the unused one.
Counted in U5's tally as duplicated authority; recorded here because the
dead-floor census is what found it.

**U4e — `crates/fork-instrument/src/call_graph.rs`: ~110 lines of an
otherwise-live 1,364-line module.** `lower_tail_call_landings` (L1236,
~85 lines) has **zero references anywhere in the repo** — not in
`crates/fork-instrument/tests/`, not in `tools/` — only a doc
cross-reference at L1234. `build_reverse_call_graph` (L238) and
`direct_reaching_closure` (L252) are likewise unreferenced outside their
definitions. Separately `analyze_reaching_closure`, `reaching_closure`
and `func_display_name` are **test-only public entry points**;
production uses `analyze_reaching_closure_from_seeds` from
`fork-instrument/src/lib.rs`.

**U4f — `crates/runtime-core/src/zip.rs`: `derive_entry` + `ZipNode`,
~70 lines (L266-333) of 334 production lines.** `derive_entry`
classifies a ZIP central-directory entry into dir/symlink/regular plus a
POSIX mode from the external-attributes field. Repo-wide it appears only
in its own file and its own tests. The live rootfs path
(`crates/runtime-core/src/rootfs.rs:2055`) calls
`read_central_directory` plus `extract` and does its own handling — it
never classifies through `derive_entry`. Control for the zero:
`read_central_directory` through the identical command shape returns
`rootfs.rs`.

**U4g — six small test-only public APIs on otherwise-live types.** High
confidence, low value each: `rewind_driver.rs`'s `is_exhausted`,
`next_frame`, `peek_frame` (zero references anywhere, including its own
tests); `replay_journal.rs`'s `unregister_activation`,
`captured_activation_ids`, `captured_event_count`;
`host_raw_syscalls.rs`'s `is_host_raw_syscall`; `trap_signal.rs`'s
`classified_trap_exit_status`; `dylink/src/metadata.rs`'s
`is_shared_library` (one repo-wide hit — its own definition);
`wasm-artifact/src/policy.rs`'s `ArtifactPolicyReport::is_acceptable`.

**Eleven false alarms cleared, listed so nobody re-chases them.** Each
looked dead to a direct symbol grep and is not: `pshared.rs`'s
`PSharedTable` (reached as a return type); `hostname.rs`'s
`parse_inet_aton` and `validate_dns_hostname` (called internally by
`resolve_locally`); `policy.rs`'s `describe_facts_policy_failures`;
`reference_analysis.rs`'s five "zero-ref" types (fields of the live
`FunctionReferenceAnalysis`); `dylink_archive_{walk,encode}.rs`
(included via `#[path = …]`); `{imported_globals,imported_tables,
exception_codec}.rs` (live via the `kernel_exec_target_artifact_policy`
export); all of `runtime-core/src/dri/**`; `wasi-abi`, `wasi-module` and
`wasm-local-root-spill` (the first instantiated at
`host/src/worker-main.ts:3363`, the last invoked from
`packages/registry/ruby/build-ruby.sh:1210`); `host_abi.rs`'s
`SYSCALL_ARG_DESCRIPTORS`; `fork.rs`'s two public functions (called from
`process_table.rs:397,1078,3637`); and `legacy_eh.rs`.

**The one I found in my own lane:**

**U4a — the immutable-product / `trusted-root-product` mechanism in
`memory-fs.ts` has no production admitter.** `host/src/vfs/types.ts:101`
labels it itself: `@deprecated Private product authority is not used by
the VFS router.` Caller census: `setIdCapability` has **three references
in the entire repo** — the type declaration (`types.ts:102`), the
parameter type (`memory-fs.ts:8392`) and the one read
(`memory-fs.ts:8394`). Nothing ever sets it. Transitively,
`snapshotForImmutableProduct` (`memory-fs.ts:3340`),
`immutableProductBackends` (`:94`), `immutableProductSharedFsPrototype`,
`immutableProductReadonlyFailure` (`:8282`) and `resolveSetIdCapability`
(`:8386-8430`) are reachable only from each other and from tests. Rough
size **200-300 lines**; I give a range rather than a number because the
machinery is interleaved with live prototype-freezing code and I did not
want to inflate it.

Control for the zero: `nosuid:` over the same corpus returns 27
production hits.

### U5 — duplicated authority: seventeen more, three of them already drifting

A separate census swept `host/src` (excluding fork and vfs), all of
`crates/`, `libc/glue`, `web-libs` and `apps/browser-demos` for one
decision made in two places. Method worth recording: a **cross-language
constant-name join** extracting 471 TypeScript `const NAME = <number>`,
1,508 Rust `pub const` and 3,993 C `#define` into 231 shared names, plus
a **prose sweep** for sync/mirror/duplicate language (434 TS hits, 1,057
Rust). The prose sweep is what found five of these; they share no
identifier with their counterparts, which is the failure mode a symbol
census cannot see.

**Already drifting — these are defects today, not drift risk.**

**U5b — the native host throws `clock_id` away, so `CLOCK_MONOTONIC` is
not monotonic on the conformance host.**
`crates/host-native/src/guest.rs:2707-2713` binds
`env.host_clock_gettime` with the parameter named **`_clock_id`** and
returns `SystemTime::now()` unconditionally. Both JavaScript hosts
branch on the id (`host/src/vfs/time.ts:18-32`,
`host/src/platform/node.ts:632-649`), and the kernel canonicalises it
properly first (`crates/runtime-core/src/syscalls.rs:9841-9864`).

The consequence is not cosmetic. The kernel's own wait queue takes
`now_ns` from `CLOCK_MONOTONIC`
(`crates/runtime-core/src/wait_queue.rs:57,79,656`, reached from
`syscalls.rs:1838,9400,9456,9500`), so **every deadline computed on
`host-native` rides wall-clock** and moves backwards when the system
clock does. POSIX requires the opposite. `host-native` is the host whose
stated job is proving the boundary is not JavaScript-shaped; a
divergence here is precisely what it exists to catch. Fix is ~7 Rust
lines. **Not tracked.**

**U5c — a second, hand-written syscall-name table, in the same file as
U2.** `web-libs/kandelo-session/src/kernel-host.ts:2529+` carries
`SYSCALL_NAMES_LOCAL`, **137 hand-maintained entries**, against
`host/src/generated/abi.ts:1398` `ABI_SYSCALL_NAMES`, **233 generated
from `wasm_posix_shared::Syscall`**. Two names are wrong (`129: statfs`,
`130: fstatfs`; the generated table says `statfs64`/`fstatfs64`) and
**96 numbers are missing**, rendering as `syscall_NNN` in the browser
syscall trace. Its own comment names
`host/src/kernel-worker.ts:SYSCALL_NAMES` as the authority — and that
line (`kernel-worker.ts:1540`) is now just `export const SYSCALL_NAMES =
ABI_SYSCALL_NAMES`. The stated reason for the copy, avoiding Node-only
imports, no longer applies: `generated/abi.ts` is a dependency-free
generated leaf. ~45 lines. **Not tracked**, and it lands in the same
file and the same lane as U2.

**U5d — four different opinions about which `fcntl` commands carry a
`struct flock *`.** `crates/shared/src/lib.rs:1160-1162` `fcntl_cmd`
says 12/13/14. `host/src/kernel-worker.ts:1077-1085` and
`libc/glue/channel_syscall.c:933-935` both add 5/6/7.
`channel_syscall.c:272` `is_slow_syscall` carries a **fourth, narrower**
list that omits cmd 7 — so a `cmd == 7` would marshal as blocking-shaped
without being declared slow. Rust is right: musl on 32-bit targets
defines `F_GETLK`/`F_SETLK`/`F_SETLKW` as the LFS values 12/13/14
(`libc/musl-overlay/include/fcntl.h:203-205`), and 5/6/7 are non-LFS
Linux values this target never emits. **Not tracked.**

**Agree today, ranked by blast radius — drift waiting to happen.** Full
table in the census; the ones that matter:

| decision | halves | removable |
|---|---|---|
| GLES cmdbuf opcode + query-op table, **70 values** | `crates/shared/src/lib.rs:4741,4795+` · `host/src/webgl/ops.ts:14-99` · `libc/glue/gl_abi.h:36-113` | ~110 TS + ~80 C |
| errno numbering | `crates/shared/src/lib.rs:841` (79 values) vs **seven** partial TS copies (`kernel-worker.ts:385-410`, `networking/virtual-network.ts:11-18`, `exec-target.ts:5-12`, `host-owned-process-reap.ts`, `vfork-lifetime.ts`, `process-lifecycle.ts:4780`, `worker-main.ts:342`) | ~50 lines |
| `WasmStatfs` `repr(C)` offsets | `crates/shared/src/lib.rs:2051-2065` · `host-native/src/guest.rs:878-906` · `host/src/kernel.ts:3243-3271` | ~27 lines |
| browser-controlled request-header policy | `host/src/networking/browser-cors-proxy.ts:21-71` · `apps/browser-demos/public/service-worker.js:1108-1147` | ~25 lines |
| `128 + signum` exit status | `crates/shared/src/trap_signal.rs:76` + **6** open-coded sites | 6 sites |
| `clockGettime` for Node | `host/src/vfs/time.ts:18-32` and `host/src/platform/node.ts:632-649` are **byte-identical bodies** | ~18 lines |

**U5e — `libc/glue/syscall_glue.c` is 1,973 orphaned lines carrying 286
`#define SYS_*`.** No build script references it, and
`sdk/test/cc.test.ts:41` *asserts* it is not passed to the compiler. It
agrees with the live table on all 215 overlapping numbers today, so it
is not a live defect — it is 1,973 lines of a third syscall-number
authority sitting in the tree with nothing keeping it honest. **Not
tracked.**

**U5f — a drift guard that guards only two of its three subjects.**
`host/src/webgl/ops.ts:2-10` claims drift between the three GL opcode
tables "is caught at first contact" via `GLIO_INIT`'s `OP_VERSION`
check. The check is real (`crates/runtime-core/src/syscalls.rs:1324`) —
but only the **C** stub's `WPK_GL_OP_VERSION` ever reaches it.
`host/src/webgl/ops.ts:99` `OP_VERSION` has **zero consumers** across
`host/src`, `apps` and `web-libs`. So a browser bridge decoding against
a stale opcode table fails silently, while a comment says it cannot.
This is the campaign's silent-success shape in its purest form: **a
guard that asserts nothing, with documentation claiming it does.** Add
it to the tally.

**U5a — the tmpfs mount table is hand-mirrored across the language
boundary, and the test that looks like it checks this cannot.**
`host/src/vfs/default-mounts.ts:18-33` says so itself:

> Scratch prefixes the in-kernel tmpfs (Phase 5) claims. **MUST stay in
> exact sync with the `SCRATCH_MOUNTS` table in
> `crates/runtime-core/src/tmpfs.rs`**; a mount whose path is one of
> these is served entirely by the kernel, so the host must not also
> materialise a backend for it (that would be a second authority the
> kernel never consults).

Both halves: `KERNEL_TMPFS_OWNED_PREFIXES` + `DEFAULT_MOUNT_SPEC`
(`default-mounts.ts:25-33, 67-102`) against `SCRATCH_MOUNTS`
(`tmpfs.rs:93-101`).

**They AGREE today** — I compared all seven entries on path, mode, uid
and gid: `/tmp` 1777, `/var/tmp` 1777, `/var/log` 0755, `/var/run` 0755,
`/home/maker` 0755 uid/gid 1000, `/root` 0700, `/srv` 0755. Identical,
in identical order.

**But nothing can detect drift.** The only test,
`host/test/vfs/default-mounts.test.ts:866-886`, builds its own fixture
*from* `KERNEL_TMPFS_OWNED_PREFIXES` and then asserts against
`KERNEL_TMPFS_OWNED_PREFIXES`. It is self-referential: it would pass
unchanged if the Rust table were emptied. That is the campaign's
silent-success shape — a check that passes because it never examines its
subject.

**One drift I went looking for and did not find, reported because a
negative matters here.** The TypeScript declares `nosuid: true` on all
seven scratch mounts. I expected the kernel not to honour it, which
would have been a security drift of the B38 family. It does:
`tmpfs.rs:180-183, 1153-1156, 1191-1194` strip `S_ISUID` and `:928`
reports `statfs_flags::ST_NOSUID`. **No finding.** Recording it so the
next agent does not re-derive it.

### U6 — declared-but-unimplemented surface: sixteen more, and several are worse than `st_rdev`

B35 was verified first, and the verification **corrected the brief's
framing in the platform's favour**: `WasmStat`
(`crates/shared/src/lib.rs:1648`) indeed has no `st_rdev`, `write_stat`
(`crates/runtime-core/src/process_wire.rs:721`) zero-fills from
`RDEV_OFFSET` onward, and a test *asserts* it stays zero
(`process_wire.rs:1301-1307`) — **but it is not silent.**
`crates/shared/src/process_layout.rs:320-324` and
`crates/kernel/src/wasm_api.rs:13031-13034` both say so explicitly. B35
is an honest-in-code unimplemented gap.

**That makes it the best-behaved member of its family.** Several of the
sixteen below are worse in a specific way: **they contradict their own
documentation.** `docs/posix-status.md` says the API returns `ENOSYS`;
the code returns success.

| # | Declared | Actually honoured | Where | Why it matters | Doc status |
|---|---|---|---|---|---|
| 1 | `setxattr`/`lsetxattr`/`fsetxattr` store an attribute | **return 0, store nothing** (`// silently accept`); the get family then answers `ENODATA` | `crates/kernel/src/wasm_api.rs:6850-6863` — **corrected**; the sweep cited "350-361", which are the *syscall numbers*, not line numbers. Verified at source: `353 => 0, // SYS_FSETXATTR: silently accept`, likewise 359 and 361 | `setfacl`, `setcap`, SELinux labelling all report success on a file that has none; `cp -a`, `rsync -X`, `tar --xattrs` silently drop them | **doc says ENOSYS** (`posix-status.md:390-392`). Honest answer is `EOPNOTSUPP`, which every one of those tools already handles |
| 2 | inotify | `inotify_init` returns a **real pollable eventfd that never fires**; add_watch returns a dummy wd without validating fd or path | `syscalls.rs:16655`; `wasm_api.rs:6890-6897` | `tail -f`, `inotifywait`, GFileMonitor, watchman, vite/webpack watch **hang** instead of falling back — every fallback is keyed on init *failing*. The code comment's own rationale ("programs will fall back to polling") is self-defeating | **doc says ENOSYS** (`posix-status.md:365-366`) |
| 3 | `renameat2` flags | `RENAME_NOREPLACE` and `RENAME_EXCHANGE` **dropped**; delegates to `renameat` | `wasm_api.rs:6799-6812` | NOREPLACE is the atomic create-if-absent primitive (GLib, Go, rustix, systemd, `mv -n`); ignoring it **overwrites the destination**. EXCHANGE **destroys** one of two files instead of swapping. Linux returns EINVAL on unknown flags | disclosed at `posix-status.md:272` — but the row is labelled **`Full`**, and the note understates a data-loss hazard |
| 4 | `get_robust_list(pid, &head, &len)` | returns 0, writes **neither** output pointer | `wasm_api.rs:14251` | caller reads its own uninitialised stack as `head`/`len`; with `set_robust_list` also a no-op, `PTHREAD_MUTEX_ROBUST` never yields `EOWNERDEAD` after an owner dies — a permanently held lock rather than a recoverable one | **doc says ENOSYS** (`posix-status.md:167`) |
| 5 | `SCM_CREDENTIALS` + `SO_PASSCRED` | constant declared in the kernel ABI **and the guest header**; `SO_PASSCRED` accepted and round-tripped; **nothing ever constructs the cmsg**, and a sent one is dropped | `crates/shared/src/lib.rs:1225`; `socket.rs:147`; `syscalls.rs:13005,12669`; `wasm_api.rs:10388` (`continue` past any non-`SCM_RIGHTS`) | AF_UNIX peer-credential auth — D-Bus, polkit, PostgreSQL `peer`, systemd. **Fail-open**: where the credential struct is zero-initialised the peer reads as **uid 0** | absent from docs |
| 6 | `SA_NODEFER`, `SA_RESETHAND` | stored verbatim and round-tripped via `oldact`; `install_caught_handler_mask_for` **unconditionally** ORs `sig_bit(signum)` so NODEFER can never take effect, and RESETHAND is read **nowhere** | `libc/musl-overlay/arch/wasm{32,64}posix/bits/signal.h:40-41`; `syscalls.rs:9606-9640`; `crates/runtime-core/src/process.rs:2458-2461` | a SIGSEGV handler installed with SA_RESETHAND re-catches forever instead of dying on the second fault — an infinite fault loop. NODEFER re-entrant handlers deadlock | silent by omission: `posix-status.md:208` scopes itself to "the default SA_NODEFER-clear/SA_RESETHAND-clear case" and never says the flags are ignored |
| 7 | `futex` op | `_ => Ok(0)` for **every** unrecognised op | `syscalls.rs:16392` | covers FUTEX_LOCK_PI / TRYLOCK_PI / UNLOCK_PI / WAIT_REQUEUE_PI / CMP_REQUEUE_PI. Returning 0 for LOCK_PI means "you acquired the PI mutex" — **two threads can both believe they hold it.** Linux: ENOSYS | silent; `posix-status.md:153` lists supported ops and says nothing about the rest |
| 8 | `prctl` option | `_ => Ok(())` for every unrecognised option | `syscalls.rs:16291` | includes the security-*establishing* options — PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, PR_SET_DUMPABLE, PR_CAPBSET_DROP. Success is a claim a restriction is in force | documented (`posix-status.md:149`), but the security subset warrants a truthful EINVAL |
| 9 | `sysinfo` | fabricated: uptime 1, totalram 512 MiB, freeram 256 MiB, **procs 1**, loads all zero | `syscalls.rs:19072` | the kernel owns a real `ProcessTable` and `MemoryManager`, so `procs` and the RAM figures are **knowable and simply not consulted** — `procs = 1` is contradicted by the machine's own process table. `free`, `top`, JVM/Node heap sizing all get plausible wrong answers | silent; no `sysinfo()` row in `posix-status.md` |
| 10 | `statfs` fallback | fabricates an **ext2** filesystem: `f_type = 0xEF53`, 4 GiB total / 2 GiB free, 65536 inodes | `syscalls.rs:18564`, reached from `:18668-18675,18684` whenever a backend answers `host_fstatfs` with ENOSYS | `df` reports invented capacity; an installer checking free space passes, then fails mid-write | silent; `posix-status.md:260` says "statistics are reported" and never mentions the fallback |
| 11 | `prlimit64(pid, …)` | `pid` never used — applies to the **calling** process | `wasm_api.rs:5709-5720,13048,13066` | `prlimit64(other_pid, …)` reads and **writes the caller's own limits** and reports success. Linux: ESRCH/EPERM | silent; no prlimit row in docs |
| 12 | ~16 TCP/IP socket options | stored and round-tripped by `getsockopt`, **never applied to a host socket** | `syscalls.rs:13001-13077` | `IP_PKTINFO`/`IPV6_RECVPKTINFO` never emit a cmsg, so a multi-homed UDP server (DNS, DHCP, NTP, mDNS) cannot learn the receiving address and **replies from the wrong one**; `SO_KEEPALIVE`/`TCP_USER_TIMEOUT` ignored so a dead peer is never detected. `SO_RCVBUF`/`SO_SNDBUF` disagree with themselves — set is stored, get returns `DEFAULT_PIPE_CAPACITY` (`:12664`) | silent. **Contrast `SO_LINGER`** (`syscalls.rs:12844-12849`), which correctly refuses with `EOPNOTSUPP` — the pattern this repo already knows and applies unevenly |
| 13 | `sched_setscheduler(pid, policy, param)` | `policy` bound as `_policy`, never read; any value returns 0, while `sched_getscheduler` always answers SCHED_OTHER | `wasm_api.rs:9783,9787-9806`; dispatch `:6443-6453` | set and get are mutually incoherent; invalid policies (Linux EINVAL) and privileged SCHED_FIFO/RR (Linux EPERM) both succeed | partial (`posix-status.md:348,350` say "no-op", not that validation is lost) |
| 14 | `shmat` address; `SHM_RDONLY` | `_shmaddr` discarded; `attach(…, _read_only: bool)` discards the flag | `wasm_api.rs:6279-6283` | a read-only attachment is **silently writable** — a process can corrupt a segment where it should fault | silent |
| 15 | `sched_setaffinity` mask | `_cpusetsize` bound, mask never read, returns 0 | `wasm_api.rs:6773-6777` | an empty cpu_set (Linux EINVAL) succeeds | documented as a scheduler stub (`posix-status.md:724`); low |

**U6-16 — eleven termios flags are stored, round-tripped, and never
consulted; one of them is on by default.** This entered as an
**unverified lead** claiming 24 termios constants in
`crates/runtime-core/src/terminal.rs` had "zero references anywhere".
**That claim is false and I disproved it before filing:** `ICRNL` alone
appears at `terminal.rs:121,194,389,437,642`, including a live input
transform at `:194`. The lead had searched outside the defining file
only.

Re-run properly — testing for each flag whether any code **branches on
it** (`c_iflag & FLAG`, `c_lflag & FLAG`, or a `c_cc[]` consultation)
rather than merely naming it — a real finding survives, and it is
narrower and of a different kind:

| flag | branched on? | consequence |
|---|---|---|
| `IXON`, `IXOFF`, `IXANY` + `VSTART`/`VSTOP` | **no** (the `c_cc` characters are assigned defaults at `:111-112`, but nothing reads them) | **software flow control does nothing.** `IXON` is set in the default `c_iflag` at `terminal.rs:121`, so the terminal reports XON/XOFF enabled and then ignores Ctrl-S/Ctrl-Q |
| `TOSTOP` | **no** | a background process writing to the terminal should get `SIGTTOU`; none is sent |
| `IEXTEN` | **no** | Ctrl-V literal-next and Ctrl-O discard are not implemented |
| `ECHOCTL` | **no** | control characters are not echoed as `^X` |
| `VEOL` | **no** | a program setting an additional canonical-mode line delimiter gets no extra delimiter |
| `CREAD`, `CS8`, `HUPCL` | **no** | control-mode flags. **These are the honest half** — for a pty with no line-discipline hardware behind it, ignoring them is arguably the correct compatibility behaviour, and I am not filing them |
| `ICANON`, `ECHO`, `ISIG` | **yes** — 25, 12 and 4 branch sites | the controls that prove the search works |

So the finding is **eight flags** (`IXON`, `IXOFF`, `IXANY`, `TOSTOP`,
`IEXTEN`, `ECHOCTL`, `VEOL`, plus the inert `VSTART`/`VSTOP` pair), not
24, and the shape is the same as U6-12's socket options: `tcsetattr`
stores them and `tcgetattr` reads them back, so a program that enables
`IXON` and reads it back sees it enabled. `IXON`-by-default makes it the
worst of the eight.

**Recorded this way on purpose.** A lead that was wrong as stated, and
correct in a different and smaller form once checked, is the single most
common event in this survey, and the difference between the two versions
is the whole value of checking.

**The structural root cause, and it is the most valuable thing in this
section.** `abi/snapshot.json` is a **layout** contract, not a
**population** contract, and its coverage has a hole exactly where B34
and B35 landed. `marshalled_structs` includes `WasmStat` — the 88-byte
*kernel* record with no `st_rdev` — while the **guest-native** layouts
processes actually read are absent: `process_native_layouts` contains
only `cmsghdr`, `iovec`, `msghdr`, `multicast_group_request`,
`scm_rights`, `sigevent`, `siginfo`, `socket_message_flags`. Missing are
`stat` (112 B, `RDEV_OFFSET = 88`), `statx` (256 B), `statfs`,
`sysinfo`, `sched_param`, `rt_sigqueueinfo`, `sigaltstack`, `itimerval`,
`mq_attr` — **7 of the 14 layout modules in `process_layout.rs`.** And
even for covered structs the snapshot records offsets, never "is this
field ever written."

**Cross-check against B34, carefully, because this is the closest call
in the survey.** B34's open half already says the offset guard is
broader than `statx` and that "`stat`'s own offsets are equally
unguarded today", and it correctly identifies the generated header as
where drift protection comes from. So **the offset half is tracked.**
What is not tracked is the *population* half — a gate that asks whether
a declared field is ever written. That is the gate that would have
caught B35 mechanically instead of by accident, and it would catch
findings 4, 5, 9 and 10 above. File it as distinct from B34, not as a
duplicate of it.

**One negative result that is a warning to whoever acts on this list.**
`SYS_MSYNC => 0` (`wasm_api.rs:6789-6792`) reads like a no-op and *its
own comment claims it is one*. It is not: the real writeback runs
host-side keyed on that exact return value
(`host/src/kernel-worker.ts:13555, 28420`), matching
`posix-status.md:226`. Only the kernel-side comment is stale. **A `=> 0`
arm cannot be classified from the kernel alone**, which is also why the
sweep that produced this table has a real blind spot — see the blind
spots section.

Checked and ruled **not** findings: `sys_mprotect`'s no-op (a genuine
wasm boundary, documented three times), `sys_usleep`, `getrusage`'s
zeros, `fadvise`/`readahead`/`sched_yield`/`mlockall` (POSIX-legitimate
no-ops), `SO_LINGER`, `SO_PEERCRED`, `RWF_*`, `fallocate` mode≠0, and
epoll `EPOLLET`/`EPOLLONESHOT` — all truthfully refused or documented.

### U7 — 27 of 72 host imports are retirable or mis-shaped, and the primary metric has no lane

Every one of the 72 was classified. Tally: **41 GENUINE FLOOR / 10
DECIDING / 17 TRADEABLE / 4 SUSPECT-DEAD.**

The JavaScript host (`host/src/kernel.ts:1551-2528`) provides all 72.
The native Rust host registers **32** and routes the other **40**
through `define_unknown_imports_as_traps`
(`crates/host-native/src/guest.rs:6096`) — so a majority of the declared
floor is unimplemented on the second host, and that asymmetry is itself
the clearest available measurement of what V4 has left to do.

**The strongest case, and it is not close: `host_waitpid`.** The host
implements the POSIX `waitpid` contract **three separate times**, and
the JavaScript copy is dead.

- `crates/runtime-core/src/syscalls.rs:19045-19051`: `sys_waitpid` is
  literally `host.host_waitpid(pid, options)`. Its `_proc` parameter is
  unused — **the kernel never consults its own process table.**
- `crates/host-native/src/guest.rs:3730-3820` therefore carries the
  whole contract: a `WaitTable { parent_of, exited }`, the
  ECHILD/EAGAIN/WNOHANG policy, and `encode_wait_status` re-deriving the
  `WIFEXITED`/`WTERMSIG` bit layout. It returns **`-ENOSYS` for `pid ==
  0` and `pid < -1`** — process-group waits do not exist on that host at
  all.
- `host/src/kernel.ts:3556-3640` needs either `waitpidSab` or
  `io.waitpid`. `registerWaitpidSab` has **no caller anywhere in the
  repo**, `onWaitpid` appears only in an audit test's string list, and
  `PlatformIO.waitpid` is optional with no implementation. So the JS
  body would return `-ECHILD` if reached — and it is not reached,
  because `host/src/kernel-worker.ts:23940-23990` intercepts `SYS_WAIT4`
  and implements a **fourth** contract (option validation → EINVAL,
  output-range → EFAULT, `wait4EventMask`, `pollWaitableChild`, a
  pending-waiter queue, signal interruption).
- The kernel already holds the material: `wait_queue.rs`,
  `wait_shadow.rs`, `kernel_wait_retire_process`,
  `kernel_reap_exited_child`, `kernel_get_parent_pid` — the last two
  already called from TypeScript in
  `host/src/host-owned-process-reap.ts`, whose own comment says "only
  Rust may atomically prove both ppid=0 ownership and Exited state."

Control for the "no caller" zeros: `onStdout` and `registerProcess` were
run as known positives over the same corpus and both hit widely.

**Partially tracked**, and the distinction matters:
`docs/plans/2026-09-09-whole-kernel-rust-migration-census.md` §6 has a
one-line "host process wait 1 → 0–1, native only". The finding that the
JS implementation is **dead** while **four** implementations diverge,
one of which cannot do process-group waits at all, is sharper than that
line and is not in the register.

**The other nine DECIDING imports.**

| import | what the host decides |
|---|---|
| `host_clock_gettime` | the POSIX clock-id table; see U5b, where the two hosts already disagree and unknown ids silently become `CLOCK_REALTIME` instead of `EINVAL` |
| `host_kms_mode_info` | **fabricates an entire `drm_mode_modeinfo`** from a canvas width and height — hsync/vsync porches, htotal/vtotal, pixel clock (`htotal*vtotal*refresh/1000`), mode-type flags, the `"WxH"` name string, and a 1920×1080@60 default when no canvas exists (`host/src/kernel.ts:627-670`). The only host *fact* is two integers; everything else is arithmetic plus a `repr(C)` layout. A second host that picks different porches shows DRM clients a different mode |
| `host_kms_set_master`, `_drop_master`, `_addfb`, `_rmfb`, `_set_fb` | five imports maintaining `host/src/dri/kms-registry.ts`, 50 lines of `Map` writes mirroring state the kernel authored. `crates/runtime-core/src/dri/master.rs` **already** holds DRM master with first-caller-wins `EBUSY` policy, so master is tracked twice |
| `host_readdir` | owns the directory-iterator cursor (`pendingDirectoryEntries`, a per-handle staged entry that must survive a failed call so an exact-capacity retry sees the same bytes) and chooses `ERANGE`. A resumable-iteration protocol a second host must reproduce exactly |
| `host_udp_send` | substitutes `localAddress` when the source is `0.0.0.0` — a routing decision, and the kernel already imports `host_network_local_address` |

**The four SUSPECT-DEAD.** `host_gl_make_current` and `host_gl_present`
have JavaScript bodies that are documented no-ops ("hook for v2");
`host_gl_create_surface` sets `b.surfaceId`, which **no code ever
reads**, and `host_gl_destroy_surface` clears the same never-read field.
All four trap on `host-native`. Control for the `surfaceId` zero:
`cmdbufAddr` over the same corpus has real production readers.

**Two collapses worth their own line.** Adding the five KMS bookkeeping
imports to the four dead GL ones, the four GBM registry imports, and
`gl_bind`/`gl_unbind`/`bind_framebuffer`/`unbind_framebuffer` gives **15
imports whose entire host-side effect is maintaining metadata the kernel
authored**; the engine-bound survivors are `gl_create_context`,
`gl_submit`, `gl_query`, `fb_write` and an attach/detach pair.
Separately, the socket family passes small interpreted scalar tuples —
IPv4 octets arrive as **four separate `u32` arguments**, and
`host_udp_send` takes **twelve parameters** — where `host_gl_query`'s
existing `(op, in_ptr, in_len, out_ptr, out_len)` shape would carry all
of it as bytes. ~11 → ~4.

**One security note under a FLOOR capability, reported because it is not
an import-count issue and would otherwise be lost:** `host_getrandom`
falls back to `Math.random()` when `crypto` is absent
(`host/src/kernel.ts:1903-1910`).

**Why this is unscoped rather than deferred.** The register's ship gate
defers "the ~9,900-line driver-glue audit" to campaign two, on the sound
argument that the audit wants a second real host as evidence. That is
the *glue*. The **import list** is a different object: it is the number
the campaign quotes as its primary metric in every ledger entry, it is
fully enumerable today without a second host, and it is the thing ABI
44's unreleased status makes cheap to change right now. Nothing in the
register schedules work against it.

### U8 — test scaffolding inside production, counted by the headline metric

`host/src/kernel-worker.ts` `#createTestAuthority` spans **lines
3617-5070 — 1,454 lines**, the second-largest declaration in the file
after `#handleSyscallInner` (2,149). With the
`CentralizedKernelWorkerTestAuthority` interface (`:2551-2663`, 113
lines) and the `createCentralizedKernelWorkerTestDouble` factory
(`:2732-2748`, 17 lines), that is **1,584 lines** of test-generation
surface in the file the Rust-First contract calls the irreducible host
floor.

**Those extents are measured, and they correct my own first number.**
The declaration-size heuristic I used to find this file's largest
members attributes everything up to the *next* declaration, which gave
`#createTestAuthority` 1,459 and the factory 212 — the factory is
actually 17 lines, and the 195-line difference was the class declaration
that follows it. Both figures are now read off the closing braces. The
same caveat applies to every size in the "largest declarations" pass
that produced this finding, and to nothing else in this document.

**It is correctly gated and I am not filing it as a safety defect.**
`kernel-worker.ts:3603` installs it only behind `arguments[3] ===
centralizedKernelWorkerTestCapability`, a module-private secret;
`kernel.ts:1043` does the same with `wasmPosixKernelTestCapability`. No
authority leaks to a production instance.

The finding is narrower and is about the metric, not the safety: the
campaign judges itself with `scripts/migration-ledger.sh`, whose scope
is `host/src` and `web-libs/kandelo-session/src` with no test-file
exclusion beyond filename patterns. Test scaffolding that lives *inside*
a production file is invisible to that exclusion. So ~1,671 lines of the
campaign's "production TypeScript" figure is test harness, and the same
is true of the ~34 `*ForTest` members spread across `kernel-worker.ts`,
`worker-main.ts`, `binary-resolver.ts` and `wasm-artifact-driver.ts`.

A related, weaker instance: `host/src/binary-resolver.ts` (4,020) +
`binary-tiers.ts` (166) are repo-layout artifact resolution over
`node:fs`, with 51 importers under `scripts/`, `images/`, `tests/` and
`benchmarks/`. The mid-campaign census already filed this shape for the
60-line `shell-runtime-layout.ts` ("**None — it is toolchain**,
mis-located … Moving it corrects the headline metric"). **I checked
whether the 4,020-line case is the same and it is not, quite:**
`resolveBinary` is called from `node-kernel-host.ts:24` and
`node-kernel-worker-entry.ts:55`, so it is on the Node *runtime* path,
not purely tooling. Reported as a partial instance, not a clean one.

### A negative result worth as much as a finding — what the target shape looks like

`host/src/audio/` (1,087 lines across 4 files) is **not** a finding, and
seeing why is useful. `crates/runtime-core/src/audio.rs:1-7` holds the
whole model — "The authoritative playback state is a refcounted
open-file-description backing … No mixer, routing policy, capture, or
Web Audio concept is part of this module's guest-facing model" — and
`host/src/audio/pcm-transport.ts:23-31` states the ownership rule
exactly: "Rust is the sole writer for stream configuration and the
producer cursor; the host sink is the sole writer for the consumer
cursor." Every constant it uses comes from `../generated/abi.js`. The
host decides nothing.

That is the shape U1, U5a and U7 are all failing to reach, and it
already exists in this tree. `host_net_readiness` is the same story on
the import side: the host reports a fact and
`net_readiness::stream_revents` decides `revents`.

## Ranking — by value, explicitly not by throughput

The schedule is someone else's problem, and the register already has a
throughput ordering ("take them in whatever order finishes the whole set
soonest"). This is the other question.

**In PR #1350:**

0. **The four documentation contradictions in U6 (xattr, inotify,
   `get_robust_list`, and `renameat2`'s `Full` label).** Ranked above
   everything else, and the reason is not their size — it is that
   `docs/posix-status.md` is the artifact a porter consults to decide
   whether Kandelo can run their software, and on these four rows it
   says the opposite of what the code does. The Documentation contract
   says "do not describe aspirational behavior as supported behavior";
   this is the inverse and is worse, because a reader who trusts the doc
   writes a fallback that never runs. `renameat2` additionally carries a
   **data-loss** hazard under a `Full` label. Fixing the doc is hours;
   fixing the code to match POSIX (`EOPNOTSUPP` for xattr, real refusal
   for inotify init) is days. **Do the doc first and separately** — it
   is the only item here that removes a falsehood without touching the
   platform.
1. **U5b — `host-native` discards `clock_id`.** Seven lines, and it is
   the only finding in this survey that silently corrupts a *result the
   conformance suite is used to trust*. The kernel's wait queue takes
   its deadlines from `CLOCK_MONOTONIC`, so on the host whose whole
   purpose is to prove the boundary is not JavaScript-shaped, every
   deadline rides wall-clock. Any timing conformance number taken on
   `host-native` is suspect until this is fixed, which makes it a
   **prerequisite for reading lane E's results**, not merely an item
   beside them.
2. **The three fail-open security items in U6 — `SCM_CREDENTIALS`
   reading as uid 0, `SHM_RDONLY` silently writable, and `prctl`'s
   security-establishing options returning success.** Grouped because
   they share one shape and it is B38's: the platform answers "yes, that
   restriction is in force" when it is not. B38 is already in scope for
   #1350 on exactly this reasoning, and these cost less to fix than B38
   does.
3. **U2a + U2b + U3 — the browser honesty cluster.** Small, local,
   independent, and they are the only findings here that are *visible to
   a user*. A machine inspector that reports the request instead of the
   state, and a mount that says `ro` while accepting writes, are the
   exact failure the Platform-Values contract names first. The kernel
   already has `/proc/mounts`; the fix to U2a is deleting a stale `if`.
   Cheapest value-per-line on the board. **U5c belongs with this
   cluster** — it is a hand-maintained syscall-name table in the same
   file, mis-naming two syscalls and missing 96.
4. **U7's SUSPECT-DEAD and DECIDING imports.** Not the whole audit — the
   register has correctly deferred that — but the subset that costs an
   epoch to reclaim later. **ABI 44 is one unreleased epoch**, and the
   register already took the pointer-width item on precisely this
   argument ("it frees the `preadv2`/`pwritev2` `flags` slot before ABI
   44 is finalised — after that, reclaiming the slot costs an epoch").
   The same argument applies, and more strongly, to the four GL imports
   whose host bodies are documented no-ops and whose native
   implementations trap. **This is the campaign's stated primary metric;
   nothing currently schedules work against it.**
5. **U5d and U5f — the `fcntl` lock-command disagreement and the GL
   drift guard that guards nothing.** Both are small, and both are the
   shape this campaign keeps paying for: a check whose documentation
   asserts a property it does not have. U5f in particular is a *twelfth*
   silent-success defect by the register's own counting convention.
6. **U5a — the tmpfs table.** Twenty lines of work to replace a
   hand-maintained mirror with a generated one, and it removes a
   self-referential test that currently certifies nothing. Cheap, and it
   closes a drift channel on the mount table, where drift means the host
   materialises a backend shadowing a kernel-owned prefix.
7. **U4a — the dead immutable-product mechanism.** Only because it is
   already labelled `@deprecated` by its own author and is entangled
   with the `readonly` question in U3; doing them together is cheaper
   than doing either alone.
8. **U4b — hand it to the fork lane rather than doing it here.** ~483
   dead lines of Rust fork module-state decoder whose live twin is 3,860
   lines of TypeScript is not a separate item; it is almost certainly
   the *other end* of the finding that lane is already scoping. Its
   value in #1350 is the handoff, not the deletion. **It is also the
   strongest single piece of evidence in this survey that the fork
   TypeScript growing and the fork Rust never running are one
   phenomenon**, which is a claim the register currently has no row for.

**A follow-up campaign:**

9. **U1 — the SFFS TypeScript.** This is the highest-value item in the
   survey and I would still not put it in #1350. Its prerequisite (W-3
   streaming emission) is in flight, its payload touches ~40 build
   scripts, and its risk profile is the same one that got lane A's five
   links split: a filesystem writer's failure mode is silent corruption.
   It also has a natural home — the register's ship gate already plans
   "a separate campaign to minimize the driver glue", and 11,880 lines
   of TypeScript filesystem is the largest single thing that campaign
   could delete. **What #1350 should carry is the row, not the work**:
   the register should say that W-4 deletes 318 of 12,198 lines and
   names the remainder, so the next campaign starts from a true number.
10. **The rest of U6 — inotify, `sysinfo`, `statfs`'s fabricated ext2,
    the ~16 stored-but-unapplied socket options, `futex` PI,
    `prlimit64`'s ignored pid, `SA_NODEFER`/`SA_RESETHAND`.** These are
    real POSIX work, not cleanups, and several need a design decision
    rather than a patch (what *should* inotify do — refuse, or grow a
    real implementation?). The platform-values contract permits them to
    stay visible as gaps; what it does not permit is the documentation
    saying they are already refused. So item 0 is the #1350 half and
    this is the campaign-two half.
11. **The population gate for `abi/snapshot.json`.** The
    highest-leverage item in U6 and the one I would most like someone to
    argue me out of deferring. A gate that asks "is this declared field
    ever written" would have caught B35 mechanically, and would catch
    four more of the sixteen. It is deferred only because it needs a
    design (how do you prove a field is populated without running the
    kernel?) and because B34's open half is already circling the same
    ground; doing them together is right, doing them in #1350 is
    probably not.
12. **U8 — the metric hygiene.** Genuinely valuable and genuinely not
    urgent. It changes what the ledger *says*, not what the platform
    *does*, and this campaign has already been burned once by optimising
    the measure.
13. **U5e — the 1,973 orphaned lines of `syscall_glue.c`.** Deleting an
    unreferenced file is the cheapest item on this page and I still rank
    it last, because it is the only one whose absence costs nothing
    today.

**My own ordering disagreement, stated because a survey that only agrees
is not worth commissioning:** the register ranks by "net host-surface
change", which is right, but it has no row at all for the host *import
list* — only for the driver glue built on top of it. U7 says 27 of 72
imports are retirable or mis-shaped. If V4 is the primary goal, the
primary metric should have a lane, and today it has none.

## What I did NOT look at, and why

A survey that claims completeness it does not have is worse than one
that names its blind spots. This campaign reported zero problems once
when the true answer was 441.

- **The fork TypeScript family.** Out of lane by instruction — a
  separate agent is scoping it. I verified its growth (premises table)
  and stopped. This is the largest single body of TypeScript in the tree
  and it is therefore the largest thing this survey did not examine.
- **No execution of any kind.** No tests, no builds, no browser, by
  instruction. Every claim here is structural. In particular, nothing
  below is validated: that `parseMounts` is unreachable at runtime (I
  proved the branch is unreachable *by construction* from the descriptor
  validator, not by running it); that the four SUSPECT-DEAD GL imports
  are never called; that the `MountSource` kinds with no materialization
  would fail rather than silently mount nothing.
- **No built kernel artifact was measured.** The 72-function count is a
  source enumeration from `wasm_api.rs`. The campaign's own rule says
  "measure the built artifact, never `EXPECTED_HOST_IMPORT_COUNT`" — I
  could do neither, so I did the third thing and said so. A
  `wasm-objdump` on an installed kernel remains owed before anyone
  quotes 72 as measured.
- **`crates/runtime-core/{memory,ofd,syscalls,process_table}.rs`,
  `crates/kernel/src/wasm_api.rs`, `sffs*.rs`, `images/`, `tests/`,
  exec-target code and the build tooling** were read for caller censuses
  but are not surveyed as subjects — other lanes hold them. In
  particular `syscalls.rs` is 49,734 lines and is the single largest
  place a declared-but-unimplemented flag could hide; the honesty sweep
  below reached it only by targeted grep, not by reading.
- **`host/src/kernel-worker.ts` was characterised, not audited.** It is
  32,728 lines, 582 declarations, and references **85 distinct `SYS_`
  constants** — it is doing per-syscall semantic work in TypeScript for
  most of the syscall table (`handleSelect` 240 lines, `handlePselect6`
  236, `handleFcntlLock` 183, `handleEpollPwait` 207, `handleClone` 374,
  `handleFutex` 275). Several of these are already owned: lane B has the
  select/pselect6 fold-in, lane A has the mapping handlers, the
  fork/exec family is the other agent's. **I did not determine which of
  the 85 are unowned.** That is the single most valuable follow-up to
  this survey and it is a day of work on its own.
- **`apps/browser-demos`** beyond tracing mount-source consumers. It is
  a consumer of `web-libs`, so U2/U3's blast radius there is stated from
  the library side only.
- **`libc/`, `sdk/`, `packages/registry/`, `benchmarks/`, `docs-site/`**
  — not examined at all.
- **Whether the procfs gaps in U2c are documented** in
  `docs/posix-status.md` or `docs/future-improvements.md`. I grepped
  `posix-status.md` for "proc" and read the head of the result, which is
  about `open`/`fork`/`exec`, not about the procfs tree. A documented
  gap is honest; I cannot say these are undocumented, only that I did
  not find them documented.

### Leads, explicitly not findings

Filed separately so nobody promotes them by accident. These were flagged
by a sweep and **not** verified; the termios lead in U6-16 shows why the
distinction matters — it was wrong as stated and correct in a smaller,
different form once checked, and two of the sixteen U6 findings exist
only because a zero was distrusted.

Zero-reference symbols seen in the automated Rust pass but **not**
individually checked for internal reachability, which is exactly how the
eleven cleared false alarms in U4 arose: `WakeupEvent`,
`WAKE_ADVISORY_LOCK`, `WAKE_DATAGRAM_WRITABLE` (`wakeup.rs`);
`DevfsEntry` (`devfs.rs`); `DecodeError`, `ResolvedSpan`
(`channel_record_decode.rs`); `MemResult`, `IoVec`
(`wasi-module/src/mem.rs`); `MAX_PREOPENS`
(`wasi-module/src/preopen.rs`); `ParsedManifest`
(`reference_segments.rs`); `key_count` (`reference_transaction.rs`);
`MUTEX_TYPE_ERRORCHECK`, `MUTEX_TYPE_RECURSIVE` (`pshared.rs`);
`ArtifactIdentity`, `ReservedEnvImport` (`contract_inventory.rs`);
`StaticReferenceCatalogPlan` (`static_reference_catalog.rs`). Most have
3-30 repo-wide hits, which usually means in-file use as a field or
return type — i.e. most are probably live.

### One trap this survey paid for, for the next census

**A generated-code pipeline is a caller, and it is the one a path list
forgets.** The Rust dead-floor census's first search set was `crates
host libc images scripts sdk` and omitted **`tools/`**. That produced a
false DEAD verdict on
`shared::host_raw_syscalls::host_raw_syscalls_sorted`, which is in fact
the source of truth `tools/xtask/src/dump_abi.rs:648` uses to generate
`host/src/generated/abi.ts`'s `HOST_RAW_SYSCALLS`. Every finding was
re-run repo-wide with `tools/` included. **Any future reachability
census in this repo must search `tools/` or it will over-report dead
code** — and over-reporting dead code is the failure mode that gets live
code deleted.

### Coverage, stated per sweep rather than as one number

This survey was run as four parallel sweeps plus my own lane. Their
coverage differs enormously and averaging it would be the kind of claim
this section exists to prevent.

| sweep | corpus | coverage | the gap that matters |
|---|---|---|---|
| **U7 — host imports** | 72 declarations in `crates/kernel/src/wasm_api.rs:56-310` | **100% classified** | Source, not artifact. ~8 of the 24 filesystem imports were traced into their `PlatformIO` backends; the rest were sampled. The browser's `getKmsCanvas`/`markKmsCanvasGlOwned` embedder callbacks were not checked for wiring |
| **U6 — declared-but-unimplemented** | `wasm_api.rs` (15,506) + `syscalls.rs` (49,734) + all of `crates/runtime-core`, `crates/shared`, `libc/musl-overlay`, `libc/glue` (186 files), `docs/*.md` | **mechanical sweep 100% of that corpus**; `process_layout.rs` read in full; ~35 regions of the two big files read closely | **`host/src` was not swept at all.** The `SYS_MSYNC` case proves a kernel `=> 0` can have its real behaviour in the host, so findings could be wrong in *either* direction, and the `O_EXCL`-ignored precedent this brief cites lived exactly there. Also untouched: the ioctl surface in depth, `termios` field-by-field honouring, and whether an existing conformance suite already xfails each item |
| **U5 — duplicated authority** | `host/src` 110 in-lane files, `crates/**` 196 files, `libc/glue` 8,071 lines, `web-libs`, `apps/browser-demos` | **~30-35% read or diffed**, plus two mechanical sweeps at ~100% of their own target shape: a cross-language constant-name join (471 TS + 1,508 Rust + 3,993 C → 231 shared names, 8 flagged, 3 real) and a prose sweep (434 TS + 1,057 Rust hits) | `packages/registry`, `images`, `scripts`, `sdk`, `benchmarks`, `tests`, `docs-site` untouched. `crates/dylink` vs `crates/dylink-module` and `crates/wasm-artifact` vs `crates/wasm-artifact-module` got structural-only treatment; the two `dylink.0` section parsers were **not** byte-compared |
| **U4 — dead Rust floors** | 196 `.rs` files under `crates/` — 130 module files, 17 crate roots, 45 tests, 4 fuzz | **130/130 module files (100%)** classified by an automated per-symbol external-reference census; **~48 of the 130** additionally hand-verified transitively. The other ~82 rest on the automated signal plus their census profile | The 45 `tests/` and 4 `fuzz/` files were not census subjects; the 17 crate roots were verified as entry points rather than assessed as candidates. **No assessment of whether `syscalls.rs` (49,734 lines) or `wasm_api.rs` (15,506 lines) contain internal dead regions** — a dead floor could hide inside either and this method would not surface it |
| **my lane — VFS, browser session, metric hygiene** | `host/src/vfs` (35 files, 22,017 lines), `web-libs/kandelo-session/src` (5,360), `host/src/kernel-worker.ts` structurally | `vfs` and `web-libs` traced by caller census; `kernel-worker.ts` **characterised, not audited** | stated above |

**The one methodological correction worth carrying forward,** because it
changed a result rather than merely embarrassing an agent: the U6
sweep's first pass scoped its absent-constant scan to `crates/` only and
reported `SA_NODEFER`, `SA_RESETHAND` and `SCM_CREDENTIALS` as simply
absent — i.e. nothing to report. Re-running it with known-positive
controls (`SO_REUSEADDR`, `SCM_RIGHTS`, `SA_RESTART`, `SA_ONSTACK`,
`EPOLLIN`, `EPOLLOUT`) and widening to `libc/musl-overlay` found all
three **declared in the guest ABI**, which is exactly what makes them
the `st_rdev` shape rather than nothing. Two of the sixteen findings
above exist only because a zero was distrusted.
