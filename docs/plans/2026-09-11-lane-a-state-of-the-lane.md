# Lane A — state of the lane at the deferral

Written 2026-09-11 when the shared-mapping cutover (B2+B3, decomposed as
A1–A5) was deferred out of PR #1350. Not cancelled: if more of it is
wanted later, the mechanism is a separate PR targeting #1350's branch,
landing there before #1350 merges.

Worktree: `.claude/worktrees/agent-a8e5b38ae12d1042d`, branch
`worktree-agent-a8e5b38ae12d1042d`. Base `87003aaad`. Eight commits,
`87003aaad..73495ec79`. **Nothing pushed.**

## 1. What is in #1350 — and a check that answered the wrong question

**All eight of this lane's commits are in #1350**, cherry-picked at
`56ceefe47` and pushed. The mapping work, the `statx` fix and the
`unlinkat` fix are all on the branch.

An earlier draft of this document said the opposite, and the mistake is
worth more than the correction.

### Compare content, not SHAs

The check was `git branch -r --contains <my-sha>`, which found nothing,
and the conclusion drawn was "the work did not land". The premise was
true and the conclusion was false: **cherry-picking creates new commits
with new SHAs**, so a containment query on the original SHA can only
ever answer "no", whatever happened to the content. Every merge
mechanism except a fast-forward changes the identifier — cherry-pick,
rebase, squash, and a rebase-merge on the forge.

**To ask whether work landed, compare content or subjects, not SHAs.**

    git log --oneline <branch> | grep -E '<subject fragment>'
    git log --oneline <branch>..HEAD        # what is genuinely unlanded
    grep -c claims_path <the file it changed>

`git rebase` onto the branch is the strongest form, because it reports
`skipped previously applied commit <sha>` for each patch-identical
commit — which is exactly the question, answered by content.

This is the same defect shape the campaign keeps paying for, and the
third instance in this lane alone: a guard that never fails, a
diagnostic that fires on every exit, and now a check that answers a
different question from the one asked. All three look like evidence and
are not.

### What is in #1350 from this lane

| Subject on the branch | Status |
|---|---|
| Run the mapping suite against the real retention table | tests |
| Let the kernel install a file mapping, not only acquire one | **removed below** |
| Refuse to skip a live process the caller never seeded | live |
| Refuse a file identity the backend cannot promise | dormant, kept |
| Give a descriptor that can have no backing no key at all | **removed below** |
| Report a whole device number from statx | live |
| Make unlinkat reach the filesystems unlink and rmdir reach | live |
| Lane A plan + four premise corrections | docs |

From earlier lanes: the handle-retention table and its three consult
sites, `shared_mapping_policy.rs` (1,108 lines), `acquire_file_backing`,
and `kernel_shared_mapping_fd_facts`.

The `unlinkat` conformance test `87003aaad` is green on the branch:
`sys_unlinkat` carries its four `claims_path` references, so the silent
data-loss bug is fixed and the test that was deliberately left red is
not red any more.

## 2. Is anything merged load-bearing on work that will not land?

This was the sharpest question asked, and the answer is yes — three
things, and I would not ship two of them.

**Dead floor, since REMOVED:**

- `track_file_mapping` / `track_fd_writeback_mapping` had **no caller of
  any kind**. They existed to be called by A2's exports.
- `backing_key_for_fd_facts` had **only test callers**. It existed to be
  the fd half of A1's resolver.

All three are gone as of the removal commit that follows this document.
They were well-tested and carefully documented, and that was exactly the
problem: a mechanism with no caller, good doc comments and green tests
reads as complete. Keeping them would have meant #1350 carrying *more*
of the shape this lane was opened to delete, not less. 368 lines removed
including their tests.

**Coverage that went with them, and is now owed.** Two of the removed
tests covered pre-existing production code rather than the removed API:
`release_writeback_fd`'s owned-versus-borrowed rule (a writeback dup the
table owns must be closed; a guest fd it merely borrowed must not), and
the middle-split case where two sub-mappings share one dup and it must
survive until the last is unmapped. Those paths are unreachable today —
nothing else in the Rust creates an fd-writeback mapping — but they are
real and subtle, and A2 must re-create that coverage when it gives them
a caller. Added as gap 9 in §4.

**Dormant but defensible (recommend keeping):**

- `file_identity_key` (`3b94039f8`). Reached only through
  `WasmSharedMappingIo::handle_identity`, which is reached only through
  `acquire_file_backing`, which has no production caller. So it is
  dormant. I would keep it anyway: it is the single formatting site for
  a backing key, it corrects a real refusal mismatch, and the mechanism
  it belongs to (`shared_mapping_policy.rs`) is already on the branch
  and already dormant. It does not *add* a floor; it makes an existing
  one correct.

**The RETIRING comments are softened**, in the same commit. They marked
`KernelIO.fileIdentity` and `fileHandleIdentity` as retiring on the
strength of A5 deleting their only callers; A5 now has no date. A
comment promising an unscheduled removal is a documentation promise the
implementation does not support, and it would have misled the next
backend author. They now say what is true: the kernel can derive the
identity itself, a new backend should declare through `StatResult.ino`,
and these stay while their callers do.

**Already inert before this lane, and staying inert:** the
handle-retention table populates nothing in production, so
`host_close_deferred_by_mapping` answers "not deferred" for every handle
on every close and teardown; and `shared_mapping_policy.rs`'s 1,108
lines have no production caller at all. Both are #1350's existing state,
not something this lane changed, but they are the reason the cutover
exists and they should be named in any accounting of what #1350 carries.

## 3. The decomposition, as I would hand it over

Sizes are mine, measured on the branch, not the register's.

**A1 — the production `SharedMappingResolver`.** Two methods. The fd
half was written and then removed as dead floor (§2); its shape is
recoverable from that commit and is three lines — refuse a descriptor
with no host handle, then `file_identity_key(dev, ino)`. The reasoning
behind the refusal is in §3 and is the part worth recovering.
`backing_key_for_path_arg` is the genuinely open one.

**A2 — the kernel exports.** About 15. Three *generalize* existing SysV
exports rather than adding surface: `kernel_shared_mapping_sysv_inherit`
already calls the whole-subsystem `inherit_process_mappings` and its own
comment says it will cover both halves unchanged; `sysv_release_process`
generalizes the same way; `sysv_active_pid_count` is the template for
the cached `has_file_backings` predicate the host needs for its three
early-out gates.

**A3 — the range policy.** Much smaller than filed. See §5.

**A4 — the first production caller.** The moment 1,108 dormant lines
start running. Gated on the coverage in §4.

**A5 — the host deletion.** 2,776 lines across 71 methods in
`host/src/kernel-worker.ts` (the register's ~2,500/57 is low), plus the
type block at `:1563-1725`, the field declarations at `:3204-3248`, and
~50 external call sites, most inside `#handleSyscallInner`. Gated on
lane B clearing that file.

### Constraints that are not visible in the code

**Two counts, and folding them is a POSIX violation.** Mapping-held
ownership is a *second* count beside the cross-process descriptor
refcount. Folding them looks like an obvious simplification and is not:
`release_ofd_reference_impl` performs `release_final_ofd_locks` inside
the same branch that performs the close, so deferring within that count
would keep an `F_OFD_SETLK` record alive for as long as the file stayed
mapped. POSIX releases the description's locks when the description
ends; the extra reference `mmap` takes is on the **file**, not the
description. The description must end on time — OFD freed, fd number
reusable, locks gone — with only the physical `host_close` withheld.

**The `&mut Process` borrow constraint, which is UB and not style.**
`fd_stat`, `fd_pwrite`, `close_fd` and (since `fcf776525`)
`process_memory_len` all borrow the global process table for the length
of the call. Every path and fd syscall entry point in `wasm_api.rs`
opens with `get_process_and_advisory_locks()`, which returns a
`&'static mut Process` held for the whole call. Invoking a policy hook
from inside one of those aliases `&'static mut Process` with
`&mut PROCESS_TABLE`. **`kernel_handle_channel` does not hold that
borrow**, so the pre- and post-syscall hooks belong at the
channel-dispatch layer — which is also where the host calls them today
(`#handleSyscallInner` wraps dispatch, not individual syscalls).

**The `SharedMappingResolver` path signature is wrong for a kernel
implementation.** `backing_key_for_path_arg(pid, dirfd, path_ptr: u64)`
assumes a guest address to be NUL-scanned, which is what the host does.
The kernel never does this: `kernel_truncate(path_ptr, path_len, …)`
receives the path as an explicit `(ptr, len)` pair already copied into
*kernel scratch*. A kernel impl must either fabricate a guest-memory
read it otherwise never performs, or reinterpret the pointer as a
kernel-scratch address — a silent confusion of two address spaces. The
method should take the decoded `&[u8]`.

**The `st_ino == 0` contract is now load-bearing across the boundary.**
A backend that cannot promise stable object identity reports
`st_ino = 0`. Written on `StatResult.ino` in `host/src/types.ts` and on
`file_identity_key`. Before `3b94039f8` these were two predicates that
merely happened to agree, and the kernel's was the permissive one.

### Dev-space disjointness — status: open, and worse than it looks

The kernel's device numbers and the host's qualified ones come from two
allocators that are **not partitioned**:

| Space | Values |
|---|---|
| Host qualified (`vfs.ts` `nextQualifiedDeviceId`) | `1n`, incrementing |
| Kernel pipe / devfs / procfs | 1, 5, 0x50 |
| Kernel rootfs | `0x7300_0000` |
| Kernel tmpfs | `0x7400_0000` .. `+16` |

Host qualified device 1 **already equals** the kernel's pipe device, and
5 equals devfs. Those are not regular files so they cannot own a
backing. Rootfs and tmpfs do hold regular files, and the only thing
keeping them apart is that the host's counter would need roughly **1.93
billion** distinct (backend, local-dev) pairs to reach `0x7300_0000`.

**They are disjoint by accident of two independently chosen constants,
neither of which documents the other.** That is not a guarantee. Record
this: it is the finding most likely to be lost, because everything works
and will keep working right up until it does not.

The agreed fix was to partition explicitly — raise the host base above
every kernel range (~2^63) and assert non-overlap in a test reading both
sides' constants. All three preconditions were checked and cleared:

1. **Nothing depends on a small `st_dev`.** Guest `struct stat.st_dev`
   is `unsigned long long` at offset 0. No `major`/`minor` use outside
   the dead statx branch in `fstatat.c`, no narrow format specifier, no
   packing.
2. **~2^63 is representable end to end.** bigint in the host, u64 on the
   wire (`setBigUint64`/`getBigUint64`), `u64` in Rust,
   `unsigned long long` in musl. Nothing on the dev path touches a JS
   `number` or an `i64`, so the sign flip at 2^63 is never observed. The
   `MAX_U64` guard still leaves ~9.2×10¹⁸ ids.
3. **No qualified dev is persisted.** VFS images hardcode `dev: 0` on
   read-back; `process_snapshot_wire.rs` has no dev at all; the fork
   wire carries one but in-session, version-gated and u64. Not a
   compatibility event.

The one genuine obstacle found — `kernel_statx` truncating `st_dev` into
`stx_dev_major` and never writing `stx_dev_minor` — **is fixed**
(`05dc3cbc6`). The partition itself was never applied. It is a one-line
constant change, one comment, and one cross-reading test.

The fd-route refusal makes the question moot for descriptors,
provably: every file backing has a host handle by
construction, because `get_or_create_file_backing` returns `ENOTSUP`
without one, so a kernel-owned descriptor can never have a backing and
computing a key for it is a lookup that cannot succeed. The **path
route** cannot use that refusal, because host-backedness is a property
of an open description and a path stat has none. That is why the
partition is still needed.

## 4. Coverage that must exist before A4

A4 is the moment 1,108 dormant lines start running. The suite as it
stands cannot see the paths A4 turns on. The proof is §6.

Eight gaps, in priority order.

1. **Resolver/identity agreement.** A test that fails if the production
   resolver produces a key `handle_identity` would not, for the same
   file. This is first because its failure mode is invisible: a resolver
   that formats a key no backing holds makes **every** policy branch
   answer "nothing maps that file" — the common case, and therefore
   indistinguishable from correct behaviour. The entire coherence layer
   would run and do nothing, with every test green.
2. **Peer publication across live processes.** Two or more pids mapping
   one file, each asserting it observes the other's stores. One new
   mapping runs `publish_file_backing_observers`, which walks every peer
   pid; an entry point seeding only its caller skips them all.
3. **Policy against the production resolver.** Every policy test today
   runs against the test double, so they test the decision table against
   an oracle rather than against real fd/path resolution.
4. **A resolver answering `None` everywhere must fail something.** If it
   does not, the policy tests are vacuous.
5. **Preparation rollback**, including the `MAP_FIXED` case where
   cleanup dropped the last old mapping of the same file in between.
6. **`classify_file_mapping` against real fd facts**, not assumed ones.
   It is pure and tested, but nothing proves the
   `KernelSharedMappingFdFacts` the kernel actually produces populate it
   the way the tests assume.
7. **Fork inheritance over a genuinely mixed table** — anonymous, file,
   fd-writeback and SysV at once. `inherit_process_mappings` has only
   ever run over an empty or SysV-only map, and
   `kernel_shared_mapping_sysv_inherit` is documented as *relying* on
   that.
8. **Exec prepare/finalize and teardown ordering** with both halves
   non-empty.

9. **The fd-writeback dup rules**, whose only tests were removed with
   the registration API: an owned dup is closed on unmap, a borrowed
   guest fd is not, and a middle split keeps the dup alive until both
   halves are gone. See §2.

Also owed a decision, not a test: `FileBacking::reload_range` and
`invalidate_range` have **no production caller in either
implementation**. Untested, uncalled code that A4 switches on is the
trap §6 already caught once. Give them a caller or delete them.

## 5. Premises that were wrong, and should not be re-inherited

Four, all re-derived on the branch rather than taken from the register.

1. **Host imports are 72 functions plus `env.memory`** (73 import
   entries), read from the built kernel with `wasm-objdump -j Import`.
   The campaign status doc says "73 functions plus `env.memory` (74
   entries)" in two places, having counted entries as functions and then
   added the memory again.
2. **A5 will almost certainly not move the import count.** Every import
   the mapping subsystem touches is used by the Rust side, which stays.
   There is no `host_stat` or `host_file_identity` import — the host's
   path route goes through `KernelIO` methods, which are not kernel
   imports. A5 shrinks production TypeScript and the `KernelIO`
   interface. Report those, not the import count.
3. **The `KernelIO` shrink is three methods.** `stat`, `fileIdentity`
   and `fileHandleIdentity` each have exactly one caller in the entire
   host, all in code A5 deletes.
4. **A3 is much smaller than filed.** "Only `pwrite` is range-precise
   today" is true of the Rust but implies the host is ahead and must be
   caught up. It is not: the host's `write`, `writev`, `pwritev`,
   `pwritev2`, `sendfile`, `copy_file_range`, `splice` and `fallocate`
   branches all call `reloadSharedMmapBackingForFd(..., undefined, ...)`
   — a whole-backing reload, identical to the Rust. One real difference
   survives: on an unavailable write buffer the host does a *ranged*
   reload and the Rust a whole-backing one. The Rust is a conservative
   superset, so it is a performance difference, not a correctness one.

## 6. The finding that justifies §4

**The writable-upgrade path of `get_or_create_file_backing` was reached
by zero of 2,037 tests.** A `panic!` at its head failed nothing.

It is the only place in the subsystem where a live backing's host handle
changes: it retains the new handle and releases the old against the
machine-wide retention table. A4 makes it live in production for the
first time.

It was found by mutation, not by reading. Removing the retain from the
*creation* path fails 6 tests; removing it from the *upgrade* path fails
none — because the upgrade's release of the old handle balances the
creation retain, so the shortfall is invisible until teardown. Four
tests now cover it (`3b94039f8`'s predecessor `d30ac3108`).

The general lesson, which cost two findings to learn: **a guard that
never fails and a diagnostic that fires on every ordinary exit are the
same defect.** Neither can distinguish the case it exists for. Every
guard this lane added was mutated until it failed, and two of them were
asserting nothing until that was done.

## 7. What I would do first on resuming

**If the cutover resumes, start with A1's path route — but with the
partition, not the resolver.** The resolver cannot be written correctly
until the dev spaces are partitioned, because the path route has no
`has_host_handle` to lean on. The partition is one constant, one
comment, one test, and all three of its preconditions are already
verified (§3). Doing it first means the resolver is written once.

**Then the §4 coverage, before any of A2.** Not after. The exports are
mechanical once the resolver exists; the coverage is what makes turning
them on safe, and gap 1 in particular protects against a failure that no
amount of later testing would reveal.

## 8. Provisioning notes for whoever picks this up

This worktree now has: the `libc/musl` submodule initialised, both
sysroots (`sysroot` and `sysroot64`), `node_modules` via `npm ci`, a
staged `local-binaries/kernel.wasm`, and `wasm_artifact_module32.wasm`.
A fresh worktree inherits none of it.

`scripts/check-abi-version.sh` needs the musl submodule and **both**
sysroots. It reports no delta for any of this lane's work.

**One provisioning defect found and not chased:**
`scripts/build-rootfs.sh` fails here because a **host**-target
`zstd-sys` build is handed the wasm SDK's cc wrapper
(`--target=arm64-apple-macosx` compiled by `sdk/bin/wasm32posix-cc`).
`CC` is plain `clang` inside the dev shell, so the leak is inside the
rootfs build rather than the environment. This is why the `unlinkat`
conformance test could not be run here; the unit tests in `73495ec79`
cover the same behaviour and run in every `cargo test`.
