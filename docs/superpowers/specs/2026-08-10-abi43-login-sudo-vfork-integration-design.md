# ABI 43 Login, Sudo, and vfork Integration

## Status

Approved by Brandon Payton on 2026-08-10. This document specifies the
forward-port architecture. It does not claim that the login stack, its
Homebrew bottles, the remaining vfork development, or the final vfork release
proof have been completed.

The implementation target is the curated, linear ABI 43 integration branch
`integration/abi43-batch-linear-20260801` and its batch pull request, #1240.
The login source behavior is the final twelve-commit stack on
`emdash/support-logins-8yaz3`. The VFS prerequisite comes from the two commits
on `emdash/vfs-decouple-from-homebrew-mdx5x`. Both branches were built before
substantial current Homebrew and ABI 43 work and therefore cannot be merged or
cherry-picked as units.

## Context

ABI 43 already contains Kandelo's genuine vfork architecture candidate. A
vfork child has an independent kernel process record, syscall channel, replay
workspace, loader state, and continuation controls while borrowing the
parent's exact `WebAssembly.Memory`. The calling parent thread remains
suspended until the child successfully execs or exits, while other parent
pthreads remain runnable. This avoids the full address-space allocation and
copy used by ordinary fork without weakening ordinary fork semantics. It is
the baseline this work must finish auditing, repair wherever evidence finds a
defect, and preserve. Its presence is not itself a completion claim.

The login source stack adds the platform behavior needed for real unprivileged
sessions: saved credentials, supplementary groups, set-ID exec, `nosuid`,
login, a small first-party sudo implementation, upstream sudo, PTY ownership,
browser autologin, and set-ID invalidation after file mutations. Its original
implementation predates the ABI 43 vfork transaction, exact memory ownership,
current exec handoff, current host entry gate, and the completed migration from
the Kandelo package registry to Homebrew.

The current VFS materialization path also still recognizes Homebrew-specific
decoder, receipt, relocation, Cellar, keg, and prefix concepts inside
`MemoryFileSystem`. That is the wrong foundation for mount security. Generic
VFS code must own archive truth, projections, transformations, metadata, and
publication; a Homebrew adapter must own Homebrew policy.

The current batch also has two unrelated CI fixture failures that must be
repaired before feature work is used as validation evidence:

1. An isolated Homebrew launcher source fixture copies `run-example.ts` but
   omits its newer `run-example-vfs.ts` dependency.
2. The generated fork-instrumentation fixture imports the pre-ABI-43
   zero-argument `kernel_fork`; ABI 43 requires the explicit fork-mode
   argument. The resulting artifact has one structurally invalid signature.

Neither failure is evidence of a vfork semantic defect. They remain required
baseline repairs.

## Goals

The forward port must:

1. provide real saved UID/GID and supplementary-group state;
2. implement truthful credential-changing and group syscalls;
3. apply set-user-ID and set-group-ID exec transitions transactionally;
4. preserve credentials across ordinary fork, vfork, exec, posix_spawn,
   pthread callers, wait, and reaping;
5. finish developing and testing vfork's no-copy memory architecture, parent
   suspension, private control state, rollback, and lifecycle behavior;
6. remove Homebrew policy from generic VFS materialization before building
   permission and mount security on that path;
7. enforce `nosuid`, ownership, permission, and set-ID invalidation behavior
   through authoritative VFS state;
8. support real login, sudo-lite, and upstream sudo through normal Kandelo
   syscalls, PTYs, signals, waits, and Homebrew bottles;
9. give Node.js and browser hosts the same observable platform behavior;
10. provide a complete local build, test, and interactive demonstration path
   before GitHub publication; and
11. finish the Homebrew/Ruby vfork release proof on the final integrated tree.

## Non-Goals

This work will not:

- restore or add Kandelo package-registry recipes;
- add broad Linux or System V compatibility;
- add Linux clone-child classes merely to accept sudo's `__WALL` flag;
- special-case Ruby, Homebrew, login, or sudo in the kernel or host runtime;
- modify upstream CRuby or broaden the temporary PR #1166 patch;
- reinterpret ordinary fork as vfork;
- replace the genuine vfork child Worker with an unproved same-worker design;
- publish or activate candidate bottles before local validation;
- merge kernel, ABI, libc, host-runtime, or fork-instrument changes; or
- squash the batch into one commit.

## Chosen Approach

Forward-port behavior into the current ABI 43 architecture in independently
reviewable layers. Preserve the original author's attribution, but do not
preserve obsolete mechanics merely to make old patches apply.

Three alternatives are rejected:

1. **Merge or cherry-pick the old branch wholesale.** This would restore ABI
   42 bindings, registry recipes, older exec handoff code, and older process
   ownership assumptions over the current vfork implementation.
2. **Port only kernel credentials.** This would leave no normal distribution
   path or end-user proof for login and sudo, and would not satisfy the request
   to bring the complete source stack into the ABI 43 batch.
3. **Add permissions to the Homebrew-aware MemoryFS and decouple it later.**
   This would make receipt and keg policy part of a security boundary, then
   require a second risky rewrite of set-ID ownership and mount decisions.

The current pre-login batch tip must remain recoverable through its existing
remote branch and pull request. Before implementation changes begin, create an
additional clearly named safety reference for the exact pre-login commit.

After the baseline fixture repairs, the first feature phase will forward-port
the two VFS commits. Generic materialization lands before mount security;
mount security lands before privileged projections; credential-aware exec
then consumes those authoritative objects. Obsolete package-registry changes
from either source branch are excluded.

## Process Credential Model

`Process` will own the authoritative credential record:

- real, effective, and saved user IDs;
- real, effective, and saved group IDs; and
- an ordered supplementary-group vector bounded by Kandelo's declared
  `NGROUPS_MAX` of 32.

Fresh root processes initialize every real, effective, and saved ID to zero.
An explicitly configured top-level UID or GID initializes all three IDs on that
side to the configured value. Supplementary groups start empty unless an
explicit process-creation contract supplies them. Login initializes the group
set through the normal `setgroups` syscall before dropping privileges.

The `setuid`, `seteuid`, `setgid`, `setegid`, `setresuid`, and `setresgid`
implementations will use the real, effective, and saved sets rather than the
current simulated aliases. `getresuid` and `getresgid` will return the stored
sets. `getgroups` will return exactly the supplementary groups; it will return
the required count for a zero-size query and `EINVAL` when a nonzero caller
capacity is too small. Only an effective UID of zero may call `setgroups`.

File access checks will consider the effective primary group and every
supplementary group. Signal permission, process inspection, ownership checks,
sticky-directory behavior, and any other credential consumers must continue
to read the same authoritative process record. A feature-specific secondary
credential cache is forbidden.

Credential-changing syscalls are atomic process-wide transitions under the
kernel entry gate. After a successful call returns, every surviving pthread
observes the new record; Kandelo does not provide per-thread credentials.

`Process` will also own an image-scoped secure-execution marker that guest
arguments and environment variables cannot set. A successful exec commit sets
it when the final real and effective user or group IDs differ, or when a future
reviewed platform policy explicitly requires secure startup. It is not cleared
by a later credential change within the same image. The marker exists to give
libc the secure-startup fact that native systems normally convey through
`AT_SECURE`; it is not a second credential authority.

## Fork, vfork, and Exec State

Ordinary fork and vfork inherit the complete credential record. The fork/exec
state format will advance from version 14 to version 15, which serializes the
saved IDs, a bounded supplementary-group list, and the secure-execution marker.
Deserialization will reject the wrong version, a group count above 32,
truncated data, and trailing or otherwise malformed state according to the
existing exact parser contract.

The vfork child already owns a separate `Process`. Adding credentials to that
record must not move credentials into borrowed Wasm memory or any parent-owned
host object. A child-side credential transition may therefore change only the
child process record. The suspended parent must observe its original
credentials after child exec, `_exit`, failed exec, trap, signal termination,
or containment teardown.

Nested vfork, ordinary fork, posix_spawn, or pthread creation from a live
vfork child remain rejected according to the existing vfork admission rules.
Side modules observe credentials through the kernel process, not through
module-local state, so no side-module credential copy is introduced.

## vfork Readiness and Remaining Development

The connected ABI 43 implementation is the starting point, not an assumption
that vfork is finished. Before credential or login behavior changes it, a
baseline readiness gate will build the current guest fixtures and run the
focused kernel, host, fork-instrument, Node.js, Chromium, Firefox, and WebKit
tests. Skipped tests caused by missing fixtures are not evidence. Every
reproduced defect must first receive a focused failing test and then a
purpose-scoped fix.

That gate must establish all of the following on the current tree:

- a vfork child neither constructs a full process `WebAssembly.Memory` nor
  copies the parent's address space;
- the calling main thread or pthread remains parked until successful exec or
  exact terminal teardown, while sibling parent pthreads remain runnable;
- the child's syscall channel, mutable imported globals, replay prefixes,
  loader state, and continuation controller cannot overwrite the parent's
  state;
- failed exec returns only to the child and leaves the lifetime coherent;
- successful exec, `_exit`, cooperative signal death, trap, and Worker crash
  settle exactly once without prematurely resuming or permanently wedging the
  parent;
- descriptor and open-file-description sharing, cwd, credentials, signals,
  process group and session state, parentage, zombies, waits, and reaping
  retain their ordinary process semantics;
- main-thread and pthread callers, repeated lifetimes, rejected overlap and
  nesting, side modules, fork-instrument replay, and allocation or launch
  rollback are covered; and
- ordinary fork remains a separate copied-address-space operation with its
  own admission and retirement behavior.

The implementation must also re-audit every point at which a child Worker can
start touching the borrowed memory. A pre-start failure may return an errno
and roll back. After that point, only an exact child-generated
`memory_quiescent` fence can authorize parent resumption or final alias
retirement. A timeout, a resolved host API call, absence from a process map,
or a Worker object becoming unreachable is not equivalent evidence.

One known boundary requires an explicit safety rule. A compute-bound vfork
child cannot process a cooperative signal message or return to its wrapper to
publish `memory_quiescent`. The browser `Worker.terminate()` API returns
`undefined`, and the
[HTML Standard](https://html.spec.whatwg.org/multipage/workers.html#dom-worker-terminate-dev)
runs worker termination in parallel with the worker's main loop; it exposes no
completion event that Kandelo can use as a cross-engine memory-quiescence
fence. Node.js has a stronger, awaitable `worker.terminate()` and final `exit`
event in its
[Worker API](https://nodejs.org/api/worker_threads.html#workerterminate), but
correctness cannot depend on a Node-only guarantee when browser hosts expose
the same Kandelo process model.

The current safe response to an externally forced fatal signal in that state
is whole-address-space containment: terminate the borrower and every process
Worker that could resume into the shared backing, emit a loud diagnostic, and
exit the affected process tree with status 139. The implementation phase will
look for a portable exact fence using the existing Worker architecture and
test it across Node.js, Chromium, Firefox, and WebKit if one exists. It must
never resume the parent merely because `terminate()` returned or a bounded
delay elapsed.

If no portable exact fence exists, the batch retains containment, keeps
`vfork()` documented as partial for this asynchronous external-kill case, and
does not claim complete POSIX vfork conformance. Adding cooperative Wasm
safe-point instrumentation, a new coordinator architecture, or another ABI
protocol solely to close that boundary requires a revised design and explicit
approval; it is not smuggled into this already large batch.

That partial state may ship only with an explicit, substantive follow-up in
`docs/future-improvements.md`, cross-linked from the `vfork()` entry in
`docs/posix-status.md`. The future-work entry must record the exact missing
guarantee, why current browser Worker APIs cannot provide it, the safe
containment behavior users observe meanwhile, likely ABI/host/instrumentation
surfaces, and the acceptance evidence required to remove the limitation. At a
minimum, that evidence includes an externally killed compute-bound borrower,
safe parent resumption, exact shared-memory quiescence, Node/browser parity,
and Chromium, Firefox, and WebKit coverage. A one-line backlog note or a
statement that the problem is merely a browser limitation is not sufficient.

After the baseline gate, the credential, prepared-target exec, secure-startup,
and set-ID changes must rerun the same vfork matrix. In particular, child-only
credential transitions, failed prepared targets, post-commit launch failures,
secure marker transport, and target-ledger cleanup must leave the parked
parent's original credentials and continuation state intact.

## Transactional Set-ID Exec

The ABI 42 source implementation changed active credentials during an exec
preflight. That is not sufficient for ABI 43: a later program-load,
address-space, or worker-start failure must not leak a privilege transition
back into the old image or a failed vfork lifetime.

ABI 43 will use one prepared-target transaction rather than passing a pathname
as executable authority. This closes a gap in the old design: `fexecve()` and
`execveat(AT_EMPTY_PATH)` name an open file description (OFD), which can remain
valid after its last pathname is renamed or unlinked. Re-resolving its
remembered pathname could load or grant credentials from a different file.

The kernel will own an opaque `PreparedExecTarget` token. For ordinary exec, a
token is bound to the caller TID and current process execution generation. For
posix_spawn, it is bound to the pending child and the exact parent launch
transaction. In both cases it names either:

- the final file opened by `execve()` or pathname-based `execveat()`; or
- a retained reference to the exact OFD supplied to
  `execveat(AT_EMPTY_PATH)` or `fexecve()`.

The remembered pathname is diagnostic data only. Closing, renaming, or
unlinking the user-visible descriptor after preparation cannot redirect or
invalidate the retained target. The target lease has its own lifetime and is
released exactly once by commit, explicit cancellation, process death, or
exec rollback.

The shared kernel/host interface will expose these ABI 43 operations. Here,
`usize` follows kernel-memory pointer width; path bytes are copied into leased
kernel scratch before entry:

```text
kernel_exec_target_prepare(
    pid: u32, caller_tid: u32, dirfd: i32,
    path_ptr: usize, path_len: usize, flags: u32
) -> i32
kernel_spawn_exec_target_prepare(
    parent_pid: u32, child_pid: u32,
    path_ptr: usize, path_len: usize
) -> i32
kernel_exec_target_size(owner_pid: u32, target: u32) -> i64
kernel_exec_target_read(
    owner_pid: u32, target: u32,
    offset_lo: u32, offset_hi: i32,
    buffer_ptr: usize, buffer_len: usize
) -> i32
kernel_exec_target_cancel(owner_pid: u32, target: u32) -> i32
kernel_exec_commit(pid: u32, caller_tid: u32, target: u32) -> i32
kernel_spawn_exec_commit(
    parent_pid: u32, child_pid: u32, target: u32
) -> i32
```

The first prepare operation resolves the syscall's path, directory descriptor,
and flags in kernel state, validates the caller, opens or retains the final
regular file, and returns a positive target token or negative errno. For
ordinary `execve`, the host supplies `AT_FDCWD` and zero flags. The spawn
variant resolves after file actions against the pending child's authoritative
CWD and credentials. Size and read access the retained object without changing
an OFD's file offset. Cancel releases an uncommitted target. The two commit
operations consume the target; the spawn form applies the same credential
transition without inventing a caller thread in a process Worker that has not
started.

The concrete snapshot signatures will use fixed-width kernel-memory pointers,
split 64-bit file offsets where JavaScript-number precision would otherwise be
ambiguous, and a nonzero 32-bit target token. Tokens are never reused within
their owning exec or spawn generation; exhaustion fails before allocation
rather than wrapping onto live authority. The shared
`CentralizedKernelWorker` wrapper owns marshalling so Node.js and browsers
cannot drift.

The transaction is:

1. While the old image remains live, the kernel prepares the exact target.
   The host may use a non-authoritative resolved-path hint only to await
   deferred VFS materialization. The final open or retained OFD, not that hint,
   supplies identity; if the final binding names a different lazy object, the
   host materializes and restarts target preparation before compilation.
2. The host reads the complete program through the target token, validates its
   ABI, and compiles it. A prepared target retains the source bytes, final
   `fstat` identity, mount identity, and a backend generation or equivalent
   executable lease.
3. For a shebang, the host prepares the interpreter as a second target and
   launches that final binary. Kandelo does not honor set-ID bits on script
   files; only the final binary target can change credentials.
4. Existing fallible caller validation runs before the irreversible image
   transition. Posix_spawn keeps its side-effect-free program preflight, then
   creates the pending child. The child inherits the complete credential
   record, applies `POSIX_SPAWN_RESETIDS` by setting effective IDs to real IDs,
   applies the remaining process attributes, and performs file actions exactly
   once. Supplementary groups remain inherited, as POSIX requires; callers
   such as login must use `setgroups()` for a complete group transition. Spawn
   then prepares the authoritative target in that child's resulting
   descriptor, credential, and CWD state. If the final bytes differ from
   preflight, the host recompiles the final target without replaying file
   actions. The child is not launched until `kernel_spawn_exec_commit`
   consumes that same target.
5. Replacement memory allocation and address-space writeback/detach preflight
   complete without discarding the old image.
6. Immediately before commit, the shared host layer revalidates the retained
   target against its prepared source. Immutable image and bottle backends pin
   an exact generation. A mutable backend must either hold an executable lease
   that prevents a conflicting mutation or compare the exact bytes again. A
   backend that cannot prove a stable set-ID target fails before privilege is
   granted. A conflicting mutable executable returns `ETXTBSY`; a backend that
   cannot supply stable object identity returns `ENOTSUP`. Host-provided
   bootstrap program maps are never credential-bearing.
7. Without an event-loop yield or another guest syscall between final
   revalidation and commit, the kernel verifies the token, caller and process
   generations, retained file identity, execute permission, current mode and
   ownership, and the owning mount's `nosuid` state. It computes proposed
   effective and saved IDs in local temporary state.
8. Only after every fallible check succeeds does `kernel_exec_commit` close
   close-on-exec descriptors, reset exec-sensitive process state, and install
   the proposed credentials and secure-execution marker. The target token is
   consumed whether commit succeeds or returns an errno.
9. The host retires the old execution generation and launches the replacement.
   A vfork parent resumes only through the existing successful-exec or terminal
   child-release path.

Only one target can commit for an execution generation. If pthreads race two
exec calls, the first successful commit advances the generation and atomically
invalidates every competing token. A failed precommit attempt cancels only its
own token. Process exit, signal death, vfork containment, host teardown, and a
trapped kernel entry drain or invalidate the complete target ledger so no open
handle or privilege authority survives its owner.

There will be no persistent partially applied credential transition and no
compatibility fallback to a targetless exec setup. The ABI 43 host will require
the prepared-target exports. The path-only `host_exec` import and public
targetless `kernel_exec_setup` and `kernel_exec_setup_for_thread` exports will
be replaced rather than retained as set-ID or OFD-identity bypasses. The
Node.js and browser `onExec` callbacks and Worker messages carry the opaque
target transaction, not a `credentialPath`. Direct `execve`, `execveat`,
`fexecve`, main-thread callers, pthread callers, and vfork children must
converge on `kernel_exec_commit`. Posix_spawn uses its explicit child commit
export and the same internal target-validation and credential-transition
implementation.

Before the commit, any failure returns the truthful errno and leaves the old
image's credentials intact. After the commit, a replacement-worker failure is
a fatal exec failure for that process; it must release a vfork parent through
the existing fatal-child path and must never resume the discarded child image.

## ABI 43 Impact

The login forward port is ABI-affecting. The ABI 43 batch will explicitly
include:

- the new fork/exec state version and credential fields;
- the prepared-target exports, target token, target-aware exec commit, and
  pending-child spawn commit;
- replacement of the path-only `host_exec` and `onExec` protocol with exact
  prepared-target authority shared by Node.js and browser workers;
- the guest-facing `kernel_get_secure_exec() -> i32` startup import and the
  image-scoped process field that supplies it;
- complete `getgroups` and `setgroups` scratch descriptors;
- supplementary-group limits used across kernel, host, and libc; and
- the removal of the targetless exec setup exports.

`ABI_VERSION` remains 43 because this epoch has not been released. The ABI 43
documentation must enumerate these additions, and `abi/snapshot.json`, the
generated TypeScript bindings, libc constants, fixtures, and consumers must be
regenerated together. Snapshot checks remain mandatory even where the fork
state buffer is semantic ABI that the structural snapshot cannot describe.

This work does not require a new vfork import, a new fork mode, new
fork-instrument frame metadata, or a change to shared-memory ownership. It
extends process state and exec handoff within the already selected explicit
vfork transaction. If implementation evidence contradicts that assessment,
work stops and the ABI design is revised before code proceeds.

No new wait-option ABI constant is authorized by this design. In particular,
Linux `__WALL` remains outside the platform contract.

## Syscall Channel Marshalling

The current host has a special one-group `getgroups` handler. It will be
replaced by a bounded ABI descriptor for the caller's requested `gid_t` array.
The buffer is an in/out transfer: copying the caller's requested range into
scratch and back preserves unused trailing entries while the kernel writes
only the returned group count. A zero-size query lends no destination. A
nonzero null destination returns `EFAULT`, insufficient caller capacity
returns `EINVAL`, and a count above `NGROUPS_MAX` is rejected before scratch
allocation.

`setgroups` will lend exactly `count * sizeof(gid_t)` input bytes under the same
bound. Wasm32 and Wasm64 tests must prove pointer-width-independent behavior,
zero-length handling, insufficient capacity, maximum capacity, and malicious
counts. Node and browser hosts must share the same marshalling implementation
or equivalent behavior with an explicitly tested boundary.

## Secure Libc Startup

Kandelo's Wasm musl startup currently has no auxiliary vector and leaves
musl's `libc.secure` false. Set-ID execution makes that unsafe: libc facilities
such as `secure_getenv`, locale and message-catalog lookup, and timezone lookup
must not treat an untrusted environment as ordinary process configuration.

The ABI 43 musl overlay will import
`kernel_get_secure_exec() -> i32` during `__init_libc`. The kernel returns only
zero or one from the authoritative process marker; a missing import is an ABI
mismatch, not a fallback to insecure startup. When the result is one, musl
sets `libc.secure` before any application constructor or `main` runs.

Secure startup will also validate descriptors 0, 1, and 2. Every closed slot
is filled with a descriptor for `/dev/null` using the normal VFS and syscall
path before privileged application code runs. This prevents a later
security-sensitive open from unexpectedly becoming standard input, output, or
error. Failure to establish those descriptors terminates startup rather than
continuing with an ambiguous descriptor table.

Static Wasm does not need a native ELF dynamic-loader policy, and this design
does not invent one. It does require musl's existing secure consumers to see
the correct marker. Tests will cover `secure_getenv`, `issetugid`, locale,
message-catalog and timezone path handling, all combinations of missing
standard descriptors, ordinary non-set-ID exec, set-ID exec, `nosuid`, and
posix_spawn with and without `POSIX_SPAWN_RESETIDS`.

## Generic VFS Materialization Prerequisite

The permissions work will first forward-port the two Brandon-authored commits
from `emdash/vfs-decouple-from-homebrew-mdx5x` into the current architecture:

1. `8a66801e6353bed9ff55fa1dc5e3b7e1b0b53e24` makes the authenticated
   receipt destination, rather than a runtime default, authoritative for an
   immutable bottle's guest prefix.
2. `ebde506115e7b4bfe26a5eaf0b7d097c3e1ee939` moves Homebrew policy out of
   generic VFS materialization.

This is a behavioral forward port, not a merge or mechanical cherry-pick. The
source branch diverged before substantial Homebrew migration work and includes
obsolete package-registry files. Only the two conceptual changes, their
applicable tests, and their documentation will be adapted to current paths.
The derived commits retain Brandon Payton as author and the forward porter as
committer.

`MemoryFileSystem` will accept only the generic closed contract:

- `zip-v1` or `tar-gzip-v1` decoding;
- a complete `archive-source-inventory-v1` source inventory;
- exact source-to-destination entries and inode groups;
- optional bounded `archive-byte-transforms-v1` assertions and replacement
  recipes with exact input and output identities; and
- generic integrity, ownership, activation, cancellation, rollback, and
  atomic-publication state.

The generic layer will contain no receipt discovery, `changed_files`, Formula,
Cellar, keg, bottle-prefix, or Homebrew relocation markers. Transformation
plans are inert, bounded data rather than callbacks, regular expressions,
plugins, or scripts.

The Homebrew-owned adapter validates the exact receipt, destination prefix,
keg mapping, changed-file set, canonical hard-link sources, and relocation
recipe. Only after validation does it erase Homebrew vocabulary into the
generic archive inventory, projection, and transformation plan. Eager and lazy
materialization use the same recipe and exact source/output identities.

The current runtime-layer descriptor is schema 5. This forward port will use
schema 6 for the incompatible relocation-plan contract and fail closed on a
schema-5 bottle that needs receipt relocation. Schema-4 ZIP artifacts remain
readable. If another reviewed runtime-layer evolution lands first, the work
will take the next unused schema rather than assigning two meanings to one
number. This descriptor schema is distinct from Kandelo's kernel ABI version.

The generic projection contract preserves regular files, directories,
symbolic links, and hard links for ordinary trees. Privileged product entries
are a narrower consumer: each must be an independently created regular-file
inode. A privileged projection may resolve a bottle hard link to its canonical
regular source, but it may not preserve that inode identity, use a symbolic
link, or share a hard link with the guest-writable bottle tree.

## VFS, Mount, and Metadata Semantics

Mount configuration will carry set-ID execution as an explicit capability.
Mounts default to `nosuid`. A mount may honor set-ID bits only when product
policy identifies it as trusted, root-owned, non-guest-writable, and able to
provide stable executable identity through the complete prepare/commit
transaction. A writable or identity-unstable backend is forced to `nosuid`
even if malformed input asks otherwise.

`statfs` reports `ST_NOSUID` for such mounts in both Node and browser hosts.
Set-ID exec consults this authoritative state at the target-aware commit
boundary and ignores both set-user-ID and set-group-ID bits on a `nosuid`
mount. Unknown mounts and host bootstrap program maps cannot grant set-ID
execution.

The existing ABI 43 branch already contains part of the old branch's chown and
set-ID invalidation behavior. The forward port will audit and retain those
correct pieces rather than replaying them. Missing behavior will cover host
files, SharedFS, path and descriptor operations, writes, truncation, ownership
changes, and metadata-only operations. Regular-file set-ID bits must not
survive a content or ownership mutation when Kandelo's documented security
semantics require clearing them.

Every backend must expose the same observable uid, gid, mode, and invalidation
result. Metadata must not be corrected only in the browser image or only in a
Node side table.

Lazy materialization into a trusted projection is an internal publication of
already authenticated bytes, not a guest write, and preserves the reviewed
owner and mode. Any later guest-visible write, truncate, ownership change, or
other qualifying mutation follows ordinary permission checks and set-ID
invalidation rules. Product validation proves that the privileged inode has no
writable alias before the image is accepted.

## PTY, Signal, and Wait Behavior

Devpts slave nodes will retain their owner, group, and mode for the lifetime of
the PTY pair. Path and descriptor stat, chmod, chown, and open permission checks
must agree. Login and sudo will use the normal controlling-terminal, session,
process-group, signal, poll/select, and wait paths.

Source commit `17384b2a5` mixes independent concerns. Its persistent devpts
slave uid, gid, mode, path/fd metadata, and open-permission behavior will be
forward-ported as one general device-semantics change. Its `ppoll()` and
`pselect()` pending-signal correction will be reproduced and, if still failing
on current HEAD, ported as a separate signal-interruption change. Existing
fixes in the batch will not be duplicated or overwritten.

That source commit also changed an advisory-lock test's mocked kernel-exit
behavior without a corresponding production change. It is not part of the
PTY or sudo design and will be retained only if an independent current
baseline failure proves it is still required.

Upstream sudo 1.9.17p2 unconditionally passes Linux `__WALL` in two child-wait
loops used by its execution paths. Kandelo has one child class and does not
implement Linux clone-child wait selection. The Kandelo platform will not add
`__WALL`, accept it as an inert flag, generate it into the host ABI, or
describe it as supported merely for this package. The sudo Formula will carry
an explicit, reviewed Kandelo compatibility patch that omits that flag while
retaining `WUNTRACED` and `WNOHANG`. This is a narrow upstream/platform
boundary, not a general Linux-compatibility promise.

## Program and Homebrew Ownership

The Kandelo repository will own the first-party program sources under the
normal `programs/` source tree:

- `login.c`; and
- `sudo-lite.c`.

The live `Kandelo-dev/homebrew-tap-core` repository will own their Formulae,
the upstream sudo Formula, build recipes, compatibility patches, tests,
sidecars, and bottle metadata. The first-party Formulae will fetch an exact
Kandelo source commit and compile those source files directly through
`kandelo_wasm_build`; they will not set `KANDELO_REGISTRY_BRIDGE` or call a
registry recipe. Upstream sudo will fetch its pinned upstream archive and use
the same SDK and artifact validation contracts.

The Kandelo batch and tap change therefore land as coordinated pull requests:

- PR #1240 owns kernel, ABI, host, VFS, source programs, rootfs, browser,
  product selection, tests, and documentation.
- A companion tap pull request owns the three Formulae and candidate bottles.

The main-shell Brewfile, migration and selection locks, materialization policy,
runtime support, bottle mirror, and image will admit the Formulae only through
the normal Homebrew composition path. The transitional helper that injected
registry-built platform programs into a Homebrew image will not be ported.

Set-ID entry points cannot safely execute from the guest-writable Homebrew
prefix, which is always `nosuid`. A reviewed system-program projection in the
image policy will copy the exact Formula-owned members into a set-ID-capable,
root-owned product mount at non-user-writable paths:

- `/usr/bin/login`, mode `04755`, uid 0, gid 0;
- `/usr/bin/sudo-lite`, mode `04755`, uid 0, gid 0; and
- `/usr/bin/sudo`, mode `04755`, uid 0, gid 0.

The projection is bound to the selected Formula, bottle digest, canonical
source member, destination, uid, gid, mode, mount policy, and artifact
validation result. It uses the generic archive-copy contract with a unique
inode identity. It may preserve lazy immutable backing, but it cannot preserve
a bottle hard link or create a symlink into the Homebrew prefix. Product
validation compares the projected inode against every writable bottle inode
and rejects an alias. A guest user cannot replace its parent directory, link,
or target. Runtime `brew install` remains available for ordinary user-owned
software but cannot mint or replace these root-owned privileged entry points.

The ordinary bottle tree and privileged projection are separate generic tree
registrations. The bottle tree retains Homebrew-owned placement and remains on
a writable `nosuid` mount. The projection tree is owned as a unit by uid 0 and
gid 0 and contains only reviewed product entries. This uses the existing
tree-owner boundary instead of adding Homebrew-specific per-entry ownership to
MemoryFS. Both trees authenticate the same immutable bottle bytes and complete
source inventory, while their destination inode groups remain disjoint.

Generic candidate ABI bottle staging is being implemented separately on
`emdash/homebrew-pr-staging-1q1w6`; its approved design names this ABI 43 batch
as the first acceptance fixture. The login forward port will not modify,
merge, rebase, or otherwise take ownership of that branch. It will consume the
reviewed staging interfaces after they land.

The staging request binds the exact Kandelo pull-request head, ABI, current
protected policy, and product requirements. Canonical VFS product manifests
declare the ordinary login, sudo-lite, sudo, Ruby, and shell Formula roots,
materialization, and product evidence. Test and browser consumer registries
select merge-gating products. The tap planner, not this integration, selects
the exact tap snapshot and resolves the transitive bottle closure. This design
therefore adds no hand-maintained staging Formula list and does not inject an
arbitrary tap commit into the cross-repository protocol.

Staging availability is a prerequisite for hosted candidate publication and
promotion, not for implementing or locally validating the platform changes.
For PR merge, the exact head must pass required-product VFS composition and its
declared Node and browser evidence through the reviewed merge-gating lane that
is actually active; observe-only staging must not be described as enforced.
The complete stock in-guest tap/install/execute lifecycle remains a local and
final-release proof rather than an additional staging-MVP merge gate. Login
integration should finish before the final Ruby and shell candidates are built
so release evidence and artifacts come from the actual merge candidate.

Only the reviewed remote GitHub workflows can create a promotable bottle
candidate. Promotion revalidates and publishes the exact authorized candidate
bytes and their bound tap, Kandelo, ABI, Formula, sidecar, and test identities.
A local bottle, local cache entry, local sidecar, or locally composed VFS is
never accepted as candidate provenance and cannot be relabeled, uploaded, or
promoted through this integration.

## Rootfs and Browser Sessions

The rootfs will contain truthful passwd, group, shadow, and sudoers state with
reviewed permissions and ownership. Demo credentials are product data for the
demo image, not host-side authentication or a UI simulation.

The reusable session layer will own one generation-tracked lifecycle record
for each logical PTY. Its product-selected policy has an initial program and a
post-exit program. Every newly allocated demo terminal launches root-authorized
`login -p -f maker` exactly once. After that process or its login shell exits,
the same terminal launches ordinary `login -p`; reattaching a UI handle does
not reset the logical terminal or repeat autologin.

`login` accepts `-f` preauthentication and `-p` environment preservation only
when its real uid is already zero. Acquiring effective uid zero by executing
the set-ID login binary is insufficient. The ordinary message of the day is
shown after every successful login. Credential hints live in a separate
root-owned `/etc/motd.autologin` and are printed only after a root-authorized
preauthenticated transition.

The supervisor permits only one active process and one pending restart per
logical PTY. Post-exit restart delay backs off from 250 milliseconds to a
maximum of five seconds after consecutive processes that survive for less
than two seconds; a process that survives at least two seconds resets the
delay. A failure to start the replacement program is printed to the terminal
and is not retried automatically. Terminal removal, kernel detach, reboot, and
host destruction cancel pending timers and generation callbacks.

A failed password remains a failed login, and an exec, PTY, or restart failure
remains visible rather than being replaced with a synthetic shell. React only
presents session state and terminal bytes; it does not authenticate users,
advance generations, or invent a successful process. Node does not need the
demo presentation, but it must run the same login and sudo binaries against
the same kernel, VFS, PTY, and credential semantics.

Upstream sudo binaries may remain deferred until first execution, but the lazy
tree, Formula identity, receipt, and bottle bytes must be normal Homebrew
artifacts. Lazy activation failure must be reported as the underlying I/O or
artifact error.

## Local Build and Demonstration Contract

GitHub must not be the first environment in which the integrated behavior is
exercised. Add `scripts/run-login-stack-local.sh`, a local orchestration entry
point that accepts an exact tap checkout and an exclusive work directory, runs
inside `scripts/dev-shell.sh`, and never publishes or mutates authoritative
selection state. It will:

1. build musl, the kernel, host runtime, and required guest fixtures;
2. build local ABI 43 bottles for login, sudo-lite, upstream sudo, pristine
   Ruby, and any selected dependencies in a disposable Homebrew prefix;
3. generate and validate sidecars against the exact local tap commit;
4. compose a review-pending main-shell VFS from the local tap and verified
   bottle cache;
5. run the Node image contract and complete guest lifecycle against a closed
   local bottle mirror;
6. run focused Chromium, Firefox, and WebKit tests where the platform path
   applies; and
7. leave the exact image and mirror available for an interactive
   `./run.sh browser` demonstration without replacing checked-in product
   assets.

The local functional demonstration must visibly cover:

```text
automatic maker login
id
sudo -l
sudo id
failed-password rejection
ordinary login after logout
nosuid execution rejection
Ruby spawning through vfork
brew tap/install/execute
```

The harness will emit an evidence report containing exact Kandelo and tap
commits, ABI, bottle identities, VFS digest, kernel digest, commands, exit
statuses, browser projects, and RSS measurements. The report identifies every
bottle and sidecar as `local-test` provenance. It will not describe local bytes
as authorized, promotable, published, public, anonymously readable, or
release-ready, and no remote workflow accepts this report as publication
evidence.

## Failure and Security Behavior

Tests must cover at least these failure boundaries:

- malformed, oversized, incomplete, or noncanonical generic archive
  inventories and transformation plans;
- source, input, output, receipt, prefix, changed-file, and runtime-layer
  schema drift before generic-tree publication;
- eager/lazy disagreement, cancellation, generation replacement, capacity
  rollback, and partial-publication attempts for generic materialization;
- privileged projection through a symlink, shared hard link, writable alias,
  non-root owner, writable mount, unstable backend, or unrecognized mount;
- invalid old/new/saved ID transitions;
- oversized, undersized, null, and malformed supplementary-group buffers;
- `POSIX_SPAWN_RESETIDS` before credential-sensitive open, chdir, and fchdir
  actions, including inherited supplementary groups;
- failed password and unknown user;
- non-root group changes;
- missing, non-regular, non-executable, or `nosuid` exec targets;
- path-target mutation before exec commit, including an unprovable mutable
  set-ID source;
- `fexecve` and `execveat(AT_EMPTY_PATH)` when another thread closes the guest
  descriptor, renames the pathname, or unlinks it after target preparation,
  proving that the retained OFD is authoritative;
- stale, cross-process, reused, cancelled, double-consumed, exhausted, and
  leaked prepared-target tokens;
- posix_spawn target failure after file actions, proving that actions run once,
  the pending child rolls back, and the parent credentials do not change;
- failed program resolution, compilation, address-space preparation, and
  replacement-worker creation;
- forged, missing, stale, or inconsistent secure-execution state; untrusted
  environment lookups; and every closed standard-descriptor combination;
- vfork child exec failure, trap, signal death, and `_exit`;
- PTY ownership and permission denial;
- `ppoll()` and `pselect()` interruption with null and non-null replacement
  masks, including `SA_RESTART` handlers;
- repeated terminal attachment, initial autologin, logout, failed password,
  bounded restart backoff, start failure, terminal removal, reboot, and stale
  generation callbacks;
- sudo policy denial, malformed sudoers, editor failure, child stop/continue,
  and signal interruption;
- lazy bottle failure; and
- set-ID removal after every supported content and ownership mutation path.

No failure may grant credentials, resume a discarded image, wedge a vfork
parent, bypass `nosuid`, invent a successful login, or silently substitute a
host-native program.

## Validation

Implementation will be test-driven. Focused failing tests precede each
behavioral change. Validation claims will use repository-declared tools through
`scripts/dev-shell.sh`.

Validation has four boundaries that must not be collapsed into one claim:

1. **vfork mechanism readiness:** audit and repair the existing implementation
   before credentials are ported, including all no-copy, suspension,
   isolation, lifecycle, failure, rollback, state, pthread, nesting,
   side-module, and cross-host evidence above;
2. **vfork integration readiness:** rerun and extend that matrix after the
   credential and prepared-target exec work, with child-only credential state
   and every failed or terminal exec path covered;
3. **whole-batch readiness:** run the complete local matrix for VFS, mounts,
   credentials, exec, PTYs, login, sudo, Homebrew, ABI, hosts, browsers,
   conformance, and performance; and
4. **release readiness:** use reviewed GitHub workflows and the exact candidate
   artifacts for bottle provenance, publication, activation, pristine CRuby,
   and the real Homebrew memory proof.

The required local matrix includes:

- Rust workspace and xtask tests;
- ABI generation and snapshot checks;
- fork/exec/vfork serialization, prepared-target, OFD, and lifecycle tests;
- host Vitest suites, including Node and Wasm64 marshalling;
- generic non-Homebrew TAR projection and transformation tests, eager/lazy
  equivalence, all supported entry types, and Homebrew-adapter regression
  tests for current and legacy authenticated prefixes;
- libc-test, Open POSIX Test Suite, and Sortix os-test coverage selected for
  credentials, exec, wait, signals, PTYs, VFS, and process lifecycle;
- Homebrew Formula build/test, sidecar generation, tap validation, image
  composition, Node smoke, and complete closed-mirror guest lifecycle;
- Chromium, Firefox, and WebKit focused tests;
- browser asset validation and manual `./run.sh browser` verification;
- fork-instrument and side-module regression coverage; and
- before/after Node and browser performance and process-tree RSS measurements.

The final publication proof additionally requires GitHub's isolated Formula
builder, exact candidate artifact relay, GHCR publication, anonymous bottle
readback, immutable selection/VFS release, and protected-main activation.
Those distribution and provenance facts cannot be claimed from local tests.

## vfork Completion and PR #1166 Removal

The existing vfork implementation must pass the mechanism-readiness gate and
receive any fixes that evidence requires; it is not exempted as pre-existing
work. Its integration gate then moves after the credential and set-ID exec
changes because those changes alter both process state and the exec lifecycle.
Only after both gates pass does the final artifact and application proof begin.

After the final ABI 43 Kandelo and tap candidates exist:

1. build and publish pristine upstream CRuby and the exact Homebrew closure;
2. prove uid 1000 selects CRuby's existing upstream vfork path;
3. prove the intentional root/privileged path still uses ordinary fork;
4. run the real in-guest tap/install/execute lifecycle without renderer loss;
5. measure Node and Chromium process-tree RSS, repeated-run bounds, and
   renderer survival, with Firefox and WebKit coverage where applicable;
6. repeat the relevant ABI, libc, POSIX, Sortix, host, browser,
   fork-instrument, and performance suites; and
7. rebuild and publish Ruby without PR #1166's Kandelo-only patch.

If the asynchronous external-kill boundary remains at that point, the same
batch must also commit the detailed `docs/future-improvements.md` follow-up and
the matching truthful `docs/posix-status.md` status before #1166 removal or
release-completion claims.

Only those exact final artifacts can support the claim that the temporary
patch has been removed from released products. Component microbenchmarks or a
local source build are insufficient.

## Commit and Review Structure

The old source commits are evidence and attribution inputs, not mechanical
cherry-pick units. Their behavior maps into purpose-scoped commits:

| Source concern | Source commits | Forward-port boundary |
|---|---|---|
| Immutable bottle prefix | `8a66801e6` | Authenticated Homebrew destination and relocation prefix |
| Generic VFS materialization | `ebde50611` | Closed archive plan, Homebrew adapter, rollback, and host parity |
| Credential/login foundation | `c44ae8019` | POSIX credentials, exec, login, rootfs, and tests |
| Upstream sudo | `a85a742d8` | Formula, policy, PTY execution, and tests |
| Browser credential UX | `7b012f9fc`, `782c6d4c3`, `6a204573a`, `d197add84` | One coherent browser-session commit |
| Lazy sudo | `c985ee105` | Homebrew lazy-tree integration |
| Metadata correctness | `598459b69`, `3e30a7765` | VFS ownership and set-ID invalidation |
| ABI credential state | `af58c77b9` | ABI 43 fork/exec state and snapshot |
| Devpts metadata | `17384b2a5` | Persistent slave ownership, mode, path/fd identity, and access checks |
| Poll interruption | `17384b2a5` | `ppoll`/`pselect` signal behavior, only if current tests reproduce it |
| Homebrew shell integration | `418da44dc` | Formula-based product/image integration |

All twelve login-source commits and both VFS-source commits were authored by
Brandon Payton. Derived commits will retain that authorship where the old work
materially supplies the change; the forward porter remains the committer.
Materially combined work uses co-author trailers where needed. `git
range-diff`, patch comparison, and `git log --format=fuller` will verify
attribution before push.

Baseline CI repairs, immutable-prefix handling, generic VFS materialization,
mount security, privileged projections, platform credentials, ABI/exec, VFS
metadata, PTY/wait, programs, tap Formulae, browser sessions, vfork fixes,
product composition, documentation, and final evidence remain distinct
conceptual commits. Separate vfork defects remain separate commits when they
protect different invariants; mechanical test or generated-artifact changes
may accompany the behavior they prove. PR #1240 must be merged with rebase
commits and must never be squash-merged.

## Completion Criteria

The forward port is complete only when:

- both pre-existing CI fixture failures are repaired;
- generic VFS materialization contains no Homebrew policy, and current
  Homebrew eager/lazy products pass through the Homebrew adapter;
- every set-ID-capable product entry is an independent root-owned inode on a
  trusted stable mount, while writable and identity-unstable mounts report and
  enforce `nosuid`;
- every behavior in the final login source stack is either present or
  explicitly rejected here for a documented platform reason;
- the ABI 43 snapshot and all generated consumers agree;
- the vfork mechanism-readiness and post-integration gates have run, every
  reproduced defect has a focused regression, and the evidence proves no full
  process-memory allocation or copy and correct caller-thread suspension;
- ordinary fork and genuine vfork retain their independent semantics, while
  repeated calls, pthread callers, nesting rejection, side modules, and
  failure rollback remain covered;
- failed exec cannot change active credentials or wedge the parent;
- exact vfork teardown resumes the parent only after `memory_quiescent`; an
  asynchronous browser kill either gains a portable exact fence or retains
  loud whole-address-space containment and remains documented as partial;
- any remaining partial vfork boundary has the required substantive future
  work entry and synchronized POSIX status rather than an untracked note;
- set-ID images enter secure libc startup and cannot inherit closed standard
  descriptors into privileged application code;
- login, sudo-lite, and upstream sudo pass in Node and browsers;
- no registry bridge supplies their product binaries;
- the local end-to-end demonstration completes from exact source and bottle
  identities;
- final candidate Homebrew artifacts complete the real guest lifecycle and
  memory proof; and
- the batch and companion tap pull requests clearly disclose validation,
  remaining publication gates, attribution, and rebase-only merge policy.
