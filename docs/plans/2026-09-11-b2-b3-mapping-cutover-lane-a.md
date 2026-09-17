# Lane A — the B2+B3 shared-mapping cutover

Plan for A1–A5, written 2026-09-11 against branch tip `7a306a543` plus
the three commits `f3ef1ff04..c6c063ee5`. Every figure below was
measured or read on that tree, not inherited.

## Premises corrected before planning

Four claims the item carried did not survive checking. They are
recorded here because two of them change what the work is.

1. **Host imports are 72 functions plus `env.memory`** (73 import
   entries), read from the built kernel with `wasm-objdump -j Import`.
   The campaign status doc says "73 functions plus `env.memory` (74
   import entries)" in two places; it counted entries as functions and
   then added the memory a second time.

2. **A5 will almost certainly not move the import count.** Every import
   the mapping subsystem touches — `host_pread`, `host_pwrite`,
   `host_proc_read_bytes`, `host_proc_write_bytes`, `host_fstat`,
   `host_close` — is used by the Rust side, which stays. There is no
   `host_stat` or `host_file_identity` import: the host's path route
   goes through `KernelIO.stat` and `KernelIO.fileIdentity`, which are
   host-worker methods, not kernel imports. What A5 shrinks is
   production TypeScript and the `KernelIO` interface, not the import
   count. Expect the three numbers to read: TypeScript strongly
   negative, imports unchanged at 72, driver glue unchanged.

3. **`KernelIO.fileIdentity` has exactly one caller in the entire
   host** (`kernel-worker.ts:27305`, inside
   `findSharedMmapBackingForPath`), and `this.io.stat(` has exactly one
   (`:27302`, the same method). `fileHandleIdentity` has one too
   (`:26472`). A5 retires all three from the `KernelIO` interface — see
   ruling 3 below. That is a real host-contract shrink and should be
   reported as one, separately from the line count.

4. **A3 is much smaller than filed.** The brief says "only `pwrite` is
   range-precise today", implying the host is more precise and the Rust
   must catch up. It is not. The host's after-syscall branches for
   `write`, `writev`, `pwritev`, `pwritev2`, `sendfile`,
   `copy_file_range`, `splice` and `fallocate` all call
   `reloadSharedMmapBackingForFd(..., undefined, ...)` — a whole-backing
   reload, identical to the Rust's `reload_backing(&key, None, io)`.
   `ftruncate`/`truncate` pass an exact length in both. `pwrite` is
   range-precise in both. See "A3" below for the one real difference.

## The identity key — three rulings, 2026-09-11

Checking whether host-specific VFS mounts (OPFS directories) change the
cutover surfaced a live bug, an unwritten invariant, and an interface
decision. All three land on A1, and all three were verified in the tree
before being accepted.

### 1. A refusal mismatch, and the kernel's side is a corruption bug

    host   platform/node.ts:326, vfs.ts:  if (ino <= 0n || dev < 0n) return null
    kernel wasm_api.rs:1207:              if dev == 0 && ino == 0 { return None }

The kernel requires *both* to be zero, so a backend reporting a real
device and no inode — `dev=7, ino=0` — is refused by the host and
accepted by the kernel, which answers `"dev:7:ino:0"`. Every file in
that mount collapses onto one key and one shared backing.

This is not a tidy-up. The host turns a null identity into **`ENOTSUP`**
(`kernel-worker.ts:26472-26483`, `resolveSharedMmapBackingKey`), so the
`mmap` *fails*. The kernel does not merely accept something the host
tolerates; it diverges from a live, deliberate refusal into silent
cross-file aliasing. Tightening the kernel to `ino == 0` is convergence
on existing behaviour, not a capability regression.

The host's `dev < 0n` half needs no counterpart: `dev` is `u64` in the
kernel, so porting it would add a branch that can never be taken.

### 2. Dropping the backend qualifier rests on an unwritten invariant

The host key is `vfs:${backendId}:${dev}:${ino}`; the kernel's is
`dev:{dev}:ino:{ino}`. The qualifier is redundant **only** because
`qualifyStat` (`vfs/vfs.ts:203`) keys its device map on the backend
*object* and hands out globally unique qualified device ids — "alias
mounts therefore agree, while distinct backend instances can never
collide."

So a shared `file_identity_key` is correct exactly as long as every
`dev` reaching it is a **qualified** dev. If the kernel ever resolves a
path through a mount and reads a backend-local dev, two files in two
different OPFS directories alias onto one backing: silent `MAP_SHARED`
corruption, in the common case, with every test green.

**A1 must prove the two dev spaces are disjoint, not merely assert at
the key layer.** For kernel-owned filesystems the dev is kernel-assigned
rather than host-qualified. If those spaces can collide, the defect is
in dev allocation, and a key-layer test would faithfully record the
corruption while it continued. The assertion is written either way, near
the top of the coverage set, because it fails the same silent way as
resolver/identity agreement.

### 3. Retire all three identity methods, and write the contract

`KernelIO.stat`'s own doc says it is "the last path-shaped method on
this interface, and it survives only because the mmap-coherence
machinery that needs it is keyed by path rather than by descriptor.
Reworking that is a change to the worker's mapping model." A5 is that
rework.

`fileHandleIdentity` looked like a different animal — the seam where a
backend *declares* whether it can promise identity, keyed to a handle so
it survives unlink and rename. Two things settle it the other way:

- It is not an idle declaration seam. It is the fd route's live identity
  source (`resolveSharedMmapBackingKey`), and A5 deletes its only
  caller. Keeping it is the dead-floor pattern this lane exists to
  clear.
- Wiring it so the kernel could hear it needs a **new host import**,
  spending the one sanctioned unspent import to carry a bit that
  `st_ino == 0` already carries. That is the campaign's goal in reverse.

Both implementations are pure functions of (qualified dev, ino) —
`node:${dev}:${ino}` and `vfs:${backendId}:${dev}:${ino}` — and ruling 2
makes the qualifier redundant. The only information in the seam is the
can-promise bit, and both spell it `ino <= 0n || dev < 0n`. Once ruling
1 lands, the kernel hears that answer through the stat it already reads.
That is what makes ruling 1 load-bearing rather than defensive.

**Condition, accepted as a condition and not a footnote.** This makes
`st_ino == 0` load-bearing across the host/kernel boundary, where today
it is two predicates that merely happen to match. Undocumented they will
drift, and the drift is silent. So the contract is written where a
backend author reads before writing — the `PlatformIO`/backend contract
in `host/src/types.ts`, and the kernel side that consumes it — in this
form:

> A backend that cannot promise stable object identity reports
> `st_ino = 0`.

Report the interface change as **three methods considered, three
removed, one contract written**.

## A1 — production `SharedMappingResolver`

Two methods, both answering "which backing key names the file behind
this?". The trait is `shared_mapping_policy.rs:54`; its only `impl`
today is the test double at `:615`.

**`backing_key_for_fd(pid, fd)`** is the easy half. It is the same call
`WasmSharedMappingIo::fd_stat` already makes —
`syscalls::shared_mapping_fd_facts(proc, &mut WasmHostIO, fd)` — then
the identity key for `(dev, ino)`.

**`backing_key_for_path_arg(pid, dirfd, path_ptr)`** must read the C
string out of guest memory, resolve `(dirfd, path)` through
`syscalls::sys_fstatat`, require `S_IFREG`, and take the same key.

### The one decision that matters

The key must be computed by **one** function, shared with
`WasmSharedMappingIo::handle_identity`, which today formats
`"dev:{dev}:ino:{ino}"` inline and returns `None` when
`dev == 0 && ino == 0`. Duplicating that literal in the resolver is the
single highest-risk mistake available in this lane: a resolver that
formats a key no backing holds makes **every** policy branch return
"nothing maps that file", which is the common case and therefore looks
exactly like correct behaviour. The whole coherence layer would be
silently inert and no test that uses the double would notice.

So A1 extracts `file_identity_key(dev, ino) -> Option<String>` into
`runtime-core` and makes both callers use it.

### Two behaviour changes to record, not hide

- The host normalizes paths **lexically** (`normalizeSharedMmapPath`,
  `:27283`), popping `..` textually, which is wrong across a symlink.
  The kernel resolves properly. The Rust is more correct; say so.
- The host reaches a backing from an fd through `sharedMmapFdCache` and
  must invalidate it on `close`, `dup`, `dup2`, `dup3` and the
  `F_DUPFD` family — five branches of the after-syscall policy that
  exist only to maintain the cache. The kernel owns the descriptor
  table, so it resolves on demand and those five branches disappear
  rather than being ported.

### Borrow constraint

The resolver borrows `PROCESS_TABLE`, joining the fd-writeback trio and
(as of `c6c063ee5`) `process_memory_len` on the contract documented at
`wasm_api.rs`'s `fd_stat`. The policy calls resolver and `io`
sequentially, never nested, so the transient borrows do not overlap —
but no entry point may hold a `&mut Process` across any of it.

## A2 — the kernel exports

Roughly 15, and three of them generalize existing SysV exports rather
than adding surface:

- `kernel_shared_mapping_sysv_inherit` already calls the whole-subsystem
  `inherit_process_mappings` and its comment says it "will cover both
  without change once that half lands". Rename, do not duplicate.
- `kernel_shared_mapping_sysv_release_process` generalizes the same way.
- `kernel_shared_mapping_sysv_active_pid_count` is the template for the
  cached `has_file_backings` predicate the host needs for its three
  early-out gates (`kernel-worker.ts:11742`, `:13446`, `:17194`).

New: boundary sync; pre-syscall flush; post-syscall reconcile; prepare
file mapping; commit prepared; abort prepared; track anonymous; flush
range; cleanup; remap; preflight remap; prepare-for-write; update
protection; prepare exec; finalize exec.

### Design win 1 — the pending-preparation slot

The host carries a `PreparedFileSharedMmap` object across **nine**
rollback sites (`:12915`, `:12946`, `:12956`, `:12980`, `:13093`,
`:13168`, `:13193`, `:13254`, `:13744`). Moving that state into the
kernel as one per-pid pending slot collapses all nine into a single
argument-free `abort_prepared(pid)`, and removes the problem of
marshalling a `String` backing key across the ABI entirely.

### Design win 2 — retire the `memory_len` parameter

`WasmSharedMappingIo::process_memory_len` is seeded per entry point, and
a pid that was never seeded answers `None`, which the table reads as
"process gone" and skips. `c6c063ee5` makes that loud for a live
process, but loud is not enough for A4: **`publish_file_backing_observers`
walks every peer pid**, so an export that seeds only its caller skips
every peer, and two live processes sharing a file each keep their own
view. The fix is not a `memory_len` argument on twelve exports. It is
one `kernel_shared_mapping_set_process_memory_len(pid, len)` the host
calls where it already registers a process and already grows memory
after `mmap`, cached kernel-side across calls. That removes the
parameter from every export **including the existing
`sysv_inherit`**, and turns `c6c063ee5`'s loss record into a backstop
that should never fire.

## A3 — the range policy

Given premise 4, A3 is not a port. It is:

1. **One real precision difference.** When the written buffer is
   unavailable, the host does a *ranged* reload
   (`reloadSharedMmapBackingRange`, `:27538`) and the Rust does a
   whole-backing reload. The Rust is a conservative superset, so this
   is a performance difference, not a correctness one. Decide
   deliberately: either give `FileBacking::reload_range` this caller, or
   delete it.
2. **`FileBacking::reload_range` and `invalidate_range` have no
   production caller in either implementation.** Untested, uncalled
   code that A4 switches on is exactly the trap the writable-upgrade
   finding already caught once. Resolve before A4: caller or deletion.
3. **The coverage below**, which is A3's real deliverable.

## Coverage to build before A4

A4 is the moment 1,108 lines of dead policy start running. The suite
that exists cannot see the paths A4 turns on. The argument is already
on the record: the writable-upgrade path of `get_or_create_file_backing`
was reached by **zero** of 2,037 tests, and it is the only place a live
backing's host handle changes. Eight gaps, in priority order.

1. **Resolver/identity agreement.** A test that fails if the production
   resolver returns a key `handle_identity` would not produce for the
   same file. This is the silent-inertness failure; nothing else catches
   it.
2. **Peer publication across live processes.** Two or more pids mapping
   one file, each asserting it observes the other's stores. Plus: after
   the memory-length registry, a test that no peer is ever unseeded.
3. **Policy against the production resolver.** Every policy test today
   runs against the double, so they test the decision table against an
   oracle, not against fd/path resolution.
4. **A resolver that answers `None` everywhere must fail something.**
   If it does not, the policy tests are vacuous.
5. **Preparation rollback.** The pending-slot abort releases exactly the
   reservation it took, including the `MAP_FIXED` case where cleanup
   dropped the last old mapping of the same file in between.
6. **`classify_file_mapping` against real fd facts.** It is pure and
   tested, but nothing proves the `KernelSharedMappingFdFacts` the
   kernel actually produces populate it the way the tests assume.
7. **Fork inheritance over a genuinely mixed table.** Anonymous, file,
   fd-writeback and SysV mappings at once. `inherit_process_mappings`
   has only ever run over an empty or SysV-only map, and
   `kernel_shared_mapping_sysv_inherit` is documented as *relying* on
   that.
8. **Exec prepare/finalize and teardown ordering** with both halves
   non-empty.

## A5 — the deletion

2,776 lines across 71 methods (recensused; the ledger's ~2,500/57 is
low), plus the type block at `kernel-worker.ts:1563-1725`, the field
declarations at `:3204-3248`, and ~50 external call sites, most inside
`#handleSyscallInner`.

Gated on lane B clearing `host/src/kernel-worker.ts`. Two agents in the
syscall hot path of that file produce a merge that compiles by luck.

Shared, not exclusive — do not delete blindly: `populateMmapFromFile`
(`:28141`) is also called by the `MAP_PRIVATE` file path at `:13343`
and `:13377`.
