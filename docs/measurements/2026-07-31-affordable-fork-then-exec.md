# Affordable fork-then-exec design and measurements — 2026-07-31

## Decision

Kandelo's excessive fork-then-exec memory cost is a platform defect, not a
CRuby defect. Ordinary `fork()` must retain its independent-address-space
semantics. The platform-owned endpoint for eligible upstream software is a
genuine `vfork()` implementation with these properties:

- it creates a distinct kernel Process and a distinct child Worker;
- the child Worker temporarily borrows the parent's existing
  `Shared WebAssembly.Memory` rather than allocating or copying one;
- the calling parent thread remains parked until that child successfully
  commits `exec()` or completes `_exit()`/signal-death teardown;
- other parent pthreads remain runnable;
- the child owns a distinct syscall channel, Wasm instance, mutable imported
  globals, and host continuation controller; and
- child replay reads, but does not consume or deallocate, the parent's saved
  fork continuation. The parent remains its sole owner and consumes it when
  resumed.

A same-Worker handoff was rejected. It would couple two Process identities to
one import closure and instance-global state, make pthread callers and side
modules substantially harder to isolate, and make a child `exec()` retire the
Worker that must later resume the parent.

This record establishes that architecture but does **not** claim that genuine
`vfork()` is implemented. The integration branch now carries the proposed ABI
43 activation-state protocol, but it still has no vfork guest import or fork
mode, kernel marker, child launch protocol, libc selection path, or parent
suspension path. Those semantic and structural choices must be explicit in the
same ABI 43 batch and snapshot, with the required approval, rather than hidden
under the copied-fork contract.

Five independently reviewable foundations are implemented now:

- ordinary `fork()` performs retired-memory admission before constructing or
  copying child memory and returns `EAGAIN` when the retirement ledger is
  saturated;
- the process-memory allocator can retain explicitly counted aliases to one
  backing and retires that backing only after the final exact alias fence;
- the linked-continuation controller can replay borrowed frame nodes without
  consuming or releasing them while giving generated Wasm a child-private
  mutable prefix;
- a cross-host lifetime coordinator admits only one borrower per address
  space and distinguishes exact parent resumption, safe pre-launch failure,
  and ambiguous termination that requires whole-address-space containment; and
- ABI 43 activation and dynamic-linker reconstruction can borrow the sealed
  process manifest and parent frame nodes while giving every active main/side
  activation a private prefix and refusing loader-controlled memory writes.

The last four are not connected to a guest-visible vfork path in ABI 43. They
prove and enforce host ownership, replay, and terminal-gating primitives the
selected architecture needs; they do not by themselves implement the guest
mode, child launch, or parent-channel completion.

Sparse exact cloning reduced resident set size (RSS) in a controlled sparse
memory case, but increased scan/copy time and has no real Homebrew result. It
is therefore not selected. Worker and module churn were measurable but small
next to the address-space copy, so worker rotation or module-specific caching
is not selected as the primary architecture.

## Scope and source state

The source baseline was commit
`2f5b3c4118c7b38f28ff60c7c8a4da89e5c67f43` on
`emdash/better-affordable-forking-8v7si`, with ABI 42. The only pre-existing
dirty state was the `tests/sortix/os-test` submodule and was left untouched.

The investigation covered, in order:

1. genuine `vfork()` semantics;
2. pre-copy fork admission and retirement accounting;
3. sparse exact cloning;
4. Worker/module churn and upstream-selected process creation; and
5. larger alternatives only where the preceding evidence left a gap.

The reviewable implementation slices on this branch are:

- `6830562e6`, pre-copy ordinary-fork admission;
- `bdbd9f641`, exact refcounted aliases to one process-memory backing;
- `32c563f20`, borrowed linked-frame replay with a private mutable prefix;
- `8accc5ed3`, exact-generation shared-vfork lifetime gating;
- `2822cb109`, separate-Worker borrowed replay in Chromium, Firefox, and
  WebKit;
- `ab2873a25`, the ABI 43 forward-port of borrowed process-wide activation and
  write-free side-module reconstruction; and
- `6e71ac438`, ABI 43 main-continuation and wasm-ld reconstruction proofs in
  Chromium, Firefox, and WebKit; and
- `6f481ba85`, ABI 43 active-side-continuation borrowing in separate Workers on
  Chromium, Firefox, and WebKit.

All slices after the ordinary-fork admission guard are deliberately unwired
foundations or component proofs. The guest import, libc, kernel state, Worker
protocol, Node/browser lifecycle integration, and fork-instrument seed changes
remain in the coordinated ABI series.

The temporary CRuby change on
[PR #1166](https://github.com/Automattic/kandelo/pull/1166) was inspected from
its separate Git ref only to define removal. It was not checked out, modified,
generalized, or used as the platform design.

## Root cause

Kandelo's current ordinary fork transaction is:

1. unwind the caller through `wasm-fork-instrument` and serialize its linked
   continuation into guest mappings;
2. clone the authoritative Rust Process state, including the calling task's
   signal mask, file descriptor and open-file-description (OFD) state, current
   directory, credentials, process group/session state, and wait parentage;
3. construct a new `Shared WebAssembly.Memory` at the parent's complete
   current length;
4. synchronously copy every byte, including the linked continuation; and
5. start a child Worker and replay the copied continuation.

That is correct for ordinary fork isolation but materially different from a
native copy-on-write fork. A long-lived Ruby process with a large linear
memory can create hundreds of children that immediately discard the clone in
`exec()`. Kandelo writes the complete new mapping before the child runs, and
the JavaScript engine independently decides when unreachable retired shared
backings return physical memory. Exact Kandelo ownership and eventual engine
reclamation therefore do not prevent a transient allocation rate from
exceeding renderer capacity.

The July 30 stock-Homebrew measurements in
[`2026-07-30-node-process-worker-init-ownership.md`](2026-07-30-node-process-worker-init-ownership.md)
separated a Node `workerData` retention issue from this underlying cost. The
one-shot initialization transport reduced maximum RSS from 14,665,089,024 to
12,883,050,496 bytes, but the surviving peak remained far beyond the live
process-memory ledger. The ownership fix was material and correct; it did not
make eager fork copies affordable.

## Genuine vfork design

### Required semantics

The applicable
[Open Group `vfork()` contract](https://pubs.opengroup.org/onlinepubs/7908799/xsh/vfork.html)
permits the child to share the caller's address space only as a constrained
prelude to successful `exec()` or `_exit()`. The child has a distinct Process
identity and return value, while the calling parent thread cannot return from
`vfork()` until that lifetime ends. Misuse by the child does not permit
Kandelo to reinterpret unrelated ordinary forks as vforks.

Kandelo should expose that distinction explicitly. The proposed guest import
is:

```c
int32_t kernel_fork(int32_t mode);
```

with snapshot-owned constants for ordinary fork and vfork. `_Fork()` and
`fork()` pass the ordinary mode. `vfork()` passes the vfork mode directly and
does not run `pthread_atfork` handlers. Both modes retain one instrumenter seed
and one call graph.

A new `kernel_vfork` import was rejected because every module and side module
would need a multi-seed call-graph union plus a new artifact-role claim. A
guest memory marker or getter was rejected because it makes invocation mode
implicit, creates another shared-memory race to validate, and is still an ABI
semantic change. Reusing `SYS_VFORK` only after unwind cannot work by itself:
the host must know which continuation operation the imported call initiated.

### Separate child Worker sharing one memory

Kandelo already shares one process memory across pthread Workers. A vfork
child should use the same engine capability but remain a separate Process
Worker and Wasm instance:

```text
parent Process / caller Worker
        |
        | kernel_fork(VFORK), unwind, SYS_VFORK
        v
kernel child Process + vfork lifetime coordinator
        |
        +---- retained alias to the same Shared WebAssembly.Memory
        |
        +---- child Worker / child Wasm instance
                 separate channel and __channel_base
                 private replay prefix in its control slot
                 borrowed continuation replay
        |
        +---- successful exec or exact child teardown
                 release child alias, resolve parent syscall
```

The parent Worker is already awaiting the fork syscall after its unwind. The
kernel Worker's `onFork` promise can remain pending for the vfork lifetime;
the original channel is completed with the child PID only after the
coordinator resolves. A pthread caller parks only that Worker. Sibling parent
threads continue on their own channels, matching the required calling-thread
suspension rather than freezing the whole process.

The child gets a newly reserved host control slot in the shared memory. Its
channel cannot be the caller's channel: syscall arguments, results, signal
delivery fields, and blocking state would otherwise overwrite the suspended
parent. The slot must be allocated from the parent generation's shared thread
slot allocator and reserved at the same range in the child Process map. That
prevents a runnable sibling pthread from reusing the bytes. The generation
owns the reservation until exact child teardown releases it. Modern process
objects already import a per-instance mutable `env.__channel_base`; the child
instance receives its own value. Stale objects that depend on the legacy
shared-memory channel-base fallback must fail the new ABI epoch rather than
enter vfork.

The slot's fork-save/scratch page also supplies the child-private replay
prefix described below. The main prefix and an active side-module prefix must
fit before launch; otherwise vfork returns `EAGAIN` before creating a borrower.
The serialized descriptor already gives the exact prefix size. A future
implementation must not assume every possible pair fits merely because normal
programs use a small prefix.

The host memory allocator needs retained leases for this one explicit sharing
case. A memory record is charged once by actual `memory.buffer.byteLength`,
holds an alias count, and enters retirement only after its final parent/child
alias crosses the exact quiescence fence. A forced release is remembered on
the shared record so a later final release cannot accidentally classify an
ambiguous generation as cooperatively quiescent.

### Borrowed continuation replay

The current copied-memory child owns its continuation copy. During replay,
`LinkedForkContinuation.nextFrame()` changes each node from `COMMITTED` to
`CONSUMED`, and `finishReplayAndRelease()` unmaps every chunk. Performing those
writes in a shared vfork memory would destroy the parent's only continuation
before it can resume.

Vfork therefore needs a read-only borrowed replay mode:

- attach and fully validate the same linked chunk chain;
- maintain replay cursors only in the child Worker's JavaScript state;
- require each node to remain `COMMITTED` but never write `CONSUMED`;
- copy the module's fixed prefix into child-owned scratch and pass that address
  to `wpk_fork_rewind_begin`;
- finish by detaching the child controller without `munmap`; and
- leave the root anchor and all chunks for the suspended parent to replay,
  consume, and release.

The private prefix is required, not optional. A first two-instance experiment
made only the JavaScript replay cursor read-only and failed: generated replay
preambles still store each address returned by `__wpk_fork_frame_next` at
offset zero of `_wpk_fork_buf`, changing the parent's root prefix. Passing a
copy of the fixed prefix to the child instance isolates that generated write
while frame callbacks continue returning payloads from the borrowed chain.

The integrated host regression uses the real ABI 43 instrumenter, a shared
`WebAssembly.Memory`, and a fresh Node Worker/Wasm instance. It snapshots every
parent continuation chunk and the sealed module-state arena, lets the Worker
rebuild the real activation registry and replay with allocation/deallocation
callbacks that throw if called, verifies the snapshots remain byte-identical,
and then successfully replays and releases the same transaction in the parent
instance.

The matching Playwright component regression sends the compiled instrumented
module and the same shared Memory to a module Worker. Chromium, Firefox, and
WebKit each replayed through a private prefix without child allocation or
release, left every parent chunk byte-identical, and then allowed the parent
instance to replay and release the chain. This is cross-engine component
evidence for safe separate-Worker replay. It is not yet a guest-visible vfork
process-lifecycle test.

The host now has the corresponding unwired process-wide side-module
foundation. Borrowed dynamic-linker replay reconstructs each complete archive
entry at the parent's exact memory and table bases while creating fresh
Worker-local instances, tables, imported globals, symbol maps, and activation
controllers. After all activations exist, the process manifest identifies the
exact active set and continuation root for each main or side activation. The
child copies each mutable fixed prefix into separately reserved scratch, reads
the owner nodes without consuming them, and detaches both continuation and
module-state controllers without clearing the parent's process launch anchor.

Instantiation itself is a write-free boundary. Standard Kandelo wasm-ld side
modules use passive data segments and export their guarded start as
`__wasm_init_memory`. Borrowed replay first compiles the original bytes for
full Wasm validation, rejects an active data segment or unrecognized start,
strips only that recognized start, and relies on complete replay's existing
relocation/constructor suppression. ABI 43 instrumented modules already carry
passive segments and an explicit staged bootstrap. Any in-flight loader stage
is rejected because resuming guest bootstrap, relocation, or constructor code
could write the suspended parent's Memory.

Focused Node tests prove that a failed second-prefix reservation rolls back the
first attached activation, no borrowed mapping is released, the sealed arena
and frame nodes remain byte-identical, and the parent can subsequently replay.
A current-SDK wasm-ld module with mutable static data reconstructs without
changing its live bytes. Matching Playwright tests send the module, ABI 43
manifest, and shared Memory to separate module Workers; Chromium, Firefox, and
WebKit all observe the live values while leaving the parent state unchanged. A
second cross-engine fixture instruments a real `env.fork` side call graph. Its
child borrows only the active side activation through the process manifest and
a private mutable prefix, while the parent bytes remain unchanged and the
parent can later consume and release the same frames. This closes the
side-controller component proof; it is still not a guest-visible
process-lifecycle test.

This code remains disconnected from process launch. The eventual vfork child
must select borrowed dynamic-linker reconciliation, reserve all activation
prefixes independently, and avoid `resetForkChildLock()`, because its lock
bytes still belong to the suspended parent. The existing no-option replay and
lock reset remain the ordinary copied-fork path.

The child's independent syscall slot cannot be used as the inherited dlopen
archive anchor. Worker initialization needs a separate inherited process
control offset so side-module reconstruction reads the parent's archive while
all child syscalls use the new channel.

No new linked-frame bytes are required by this design. Borrowed versus owned
node traversal is host controller state, and `fixed_prefix_size` already
describes the exact bytes to copy. Worker initialization nevertheless needs
distinct owner-continuation and private-replay-prefix addresses. Vfork is also
an ABI semantic change because old hosts would consume shared frames and old
programs cannot request the mode safely.

### Kernel state and process behavior

`ProcessTable::fork_process_for_caller()` is the right kernel-state starting
point for both modes. It already:

- validates the exact calling task;
- creates a globally unique PID and one-task child;
- inherits the caller's blocked signal mask;
- copies descriptor and OFD metadata while retaining kernel-global backing
  references;
- copies cwd, credentials, process group, session, umask, limits, and signal
  dispositions;
- preserves parentage and wait/reaping state; and
- excludes other parent pthread tasks from the child.

The vfork difference is host address-space ownership and caller suspension,
not an alternate fake Process record. The child retains its independent
kernel metadata while borrowing the bytes. Descriptor actions, cwd changes,
credential checks, process-group changes, `exec()` commit, signal death,
zombie state, and `waitpid()` therefore continue through the ordinary kernel
path.

The coordinator must add an explicit vfork-child state so operations that
would create ambiguous shared-memory ownership fail before mutation. The
initial implementation should return `EAGAIN` for:

- another active vfork from the same address space;
- nested vfork or ordinary fork from a vfork child;
- pthread creation by a vfork child; and
- host operations that require allocating another owner for the borrowed
  address space.

Those calls are outside the permitted vfork-child pre-exec use. Returning a
truthful failure is safer than silently treating them as ordinary fork or
allowing channel/control collisions. Sequential vfork calls after the prior
child completes remain supported and must be tested.

For nested `fork()`/`vfork()`, the vfork-child Worker must reject directly in
its `kernel_fork` import before `beginUnwind()`, frame reservation, anchor
writes, or side-module lock changes. The kernel Process marker is a second
defense for raw host-intercepted requests. Rejecting only after continuation
serialization could allocate mappings that the parent does not know about or
overwrite the continuation it still owns.

### Exec, exit, trap, crash, and signal completion

A failed `exec()` is not the end of a vfork lifetime. It returns its real
errno on the child channel; the child may report the failure and call
`_exit()`. The parent remains parked, the child retains its memory alias, and
the saved continuation remains borrowed.

A successful `exec()` becomes the completion boundary only after:

1. the replacement Process generation is committed;
2. the old vfork child Worker reports `exec_retired` and
   `memory_quiescent` for the exact shared generation;
3. the child continuation controller has detached without writes or unmap;
4. the child drops its retained alias; and
5. the parent generation is still the generation whose channel is parked.

`_exit()` and signal death use the equivalent exact process teardown fence.
The existing Worker error/exit safety net converts uncaught traps and crashes
to signal-style process death; vfork coordination must settle from that one
terminal path, not from a second best-effort listener.

Signals selected for the parked parent caller must remain pending without
completing or reusing its fork channel, then follow the ordinary delivery path
after vfork resolves. Process-directed signals may still select another
eligible parent task. The child has its copied signal mask and dispositions
but independent pending state; a terminating child signal completes the vfork
lifetime through exact child teardown before the caller resumes.

An unacknowledged forced termination is different. Kandelo cannot prove that
the terminated Worker stopped touching shared memory. It must not resume the
parent into that backing. The safe containment policy is to terminate the
whole address-space owner group (parent Process Workers and the borrower),
record a loud host diagnostic, and complete process death. Leaving the parent
parked forever or resuming it after an ambiguous `Worker.terminate()` would
both violate the platform contract.

If another parent thread commits parent `exec()` or exit while the caller is
parked, that transition invalidates the pending parent channel. Retained
leases keep the old backing alive for the child, but the coordinator suppresses
the stale parent completion and releases the parent alias through the normal
generation ledger.

### Host lifetime coordinator foundation

The shared `VforkLifetimeCoordinator` records exact parent and child generation
objects and keys active borrowing by `WebAssembly.Memory`, not numeric PID. It
admits only one active lifetime per address space, so overlapping calls by
sibling threads and nested calls by the borrower receive `EAGAIN`. A completed
child generation cannot be reused, while a later child generation can begin a
new sequential lifetime over the same parent Memory.

The launch path has an explicit point of no return. Before
`markChildMayAccessMemory()`, a setup failure may return an errno because no
child realm could have touched the backing. The host must call that method
immediately before Worker start. After it, only exact exec/exit/signal/trap
teardown can produce a `resume-parent` disposition. A missing quiescence fence
produces `contain-address-space`, never a normal return. Failed exec merely
increments diagnostic state and leaves the lifetime pending.

The coordinator retains the exact parent generation in every disposition.
The eventual Node/browser integration must still compare it with the current
PID registration before completing the parked channel; this preserves the
existing stale-generation suppression when a sibling pthread execs or exits
the parent. The 13 focused state-machine tests cover an unresolved caller gate
with unrelated event-loop progress, repeated failed exec, all exact terminal
reasons, pre-launch rollback, pre-launch signal death, ambiguous termination,
competing terminal notifications, overlapping/nested `EAGAIN`, distinct
concurrent address spaces, sequential reuse, child-generation reuse rejection,
and stale-parent identity.

This coordinator is deliberately unwired until the ABI mode and Process marker
are coordinated. Existing async `onFork` completion is the actual caller-thread
parking transport, and existing Worker-quiescence and exact-generation detach
ledgers remain the source of terminal evidence.

### Test matrix for the vfork series

The vfork implementation is not complete until tests prove all of the
following on Node and the applicable browser hosts:

- no `WebAssembly.Memory` constructor and no full-memory copy occur on vfork;
- a main-thread caller cannot pass the call site before child exec/_exit;
- a pthread caller parks while a sibling parent thread continues;
- the child channel cannot change the caller's pending channel bytes;
- failed exec returns to the child and leaves the parent parked;
- successful exec, `_exit`, caught signal death, trap, and Worker crash each
  settle exactly once and cannot wedge or prematurely resume the parent;
- descriptors/OFDs, cwd, credentials, signal masks/dispositions, process
  groups, parentage, zombie state, and wait/reaping match the kernel contract;
- repeated sequential calls work and unsupported overlapping/nested calls
  return `EAGAIN` without a child or leaked slot;
- side-module replay borrows both chains and restores the parent archive;
- fork-instrument abort replay and resource-failure rollback leave the parent
  continuation usable; and
- Chromium, Firefox, and WebKit run the same lifecycle wherever their Worker
  path applies.

## Pre-copy admission for ordinary fork

Before this change, `acquireForForkSnapshot()` deliberately bypassed the
retired-generation gate. The host first constructed and copied the complete
child memory, then asynchronously waited to launch its Worker. That preserved
snapshot timing, but it defeated the purpose of retirement admission: the
expensive allocation had already happened.

Fork now uses the allocator's normal synchronous admission path. The check
runs after refreshing all live records to their actual current byte lengths
and before `new WebAssembly.Memory(...)`. Saturation is based on both retired
count and retired actual bytes. The default thresholds are:

- count: `max(4, min(32, maxWorkers * 2))`; and
- bytes: `min(maxProcessMemoryBytes, 256 MiB)`.

Retirement uses the actual final buffer length, including unmediated guest
growth. Exact Worker/channel/framebuffer teardown remains the authority for
dropping Kandelo's strong alias. `FinalizationRegistry` remains optional
telemetry. The separate retirement backpressure record lasts for a bounded
50 ms by default; spawn and exec may wait for the bounded allocator retry
window, while fork cannot yield before its snapshot and returns `EAGAIN`
immediately when saturated.

This is a burst guard, not a portable physical-memory ceiling. JavaScript
provides neither a collection deadline nor physical backing usage. Already
live generations can retire together above the thresholds, and a backing may
remain resident after its time-bounded admission charge expires. The guard is
still necessary: it prevents the known ordering error where a saturated
ledger admitted one more complete clone before checking anything.

The regression test constructs a saturated four-page retired debt, spies on
the `WebAssembly.Memory` constructor, and verifies that fork throws
`ProcessMemoryRetirementBacklogError` (`errno == EAGAIN`) with zero constructor
calls. Node and browser fork handlers share the same helper, and both retain
the required clone-before-first-`await` ordering after successful admission.

## Measurements

### Environment

- Host: Apple Silicon Mac17,6, 48 GiB RAM, macOS 26.6 (25G72)
- Node: v24.15.0 from `scripts/dev-shell.sh`
- Playwright: repository lockfile installation
- Chromium: 149.0.7827.55
- Firefox: 151.0
- WebKit: 26.5 (Playwright WebKit, not shipping Safari)
- Source: the baseline commit above plus the admission and measurement changes
  documented here

RSS is process resident set size. It includes engine heaps, JIT code, Worker
stacks, and shared mappings; it is not a direct count of private process-memory
pages.

### Component isolation

The committed harness
[`benchmarks/measure-fork-memory-components.mjs`](../../benchmarks/measure-fork-memory-components.mjs)
was run twice:

```sh
bash scripts/dev-shell.sh \
  node benchmarks/measure-fork-memory-components.mjs
```

Every case runs in a fresh subprocess without `--expose-gc`. Worker cases use
32 sequential Workers. Module cases transport the real 56,987-byte
`fork-bench.wasm` compiled module. Memory cases use a 256 MiB shared memory
with one complete nonzero Wasm page out of every 16 (16 MiB nonzero).

| Case | Run A | Run B | Interpretation |
|---|---:|---:|---|
| Worker-only peak growth | 13.297 MiB | 13.313 MiB | bounded Worker cost |
| Module-Worker peak growth | 13.563 MiB | 13.906 MiB | only 0.266–0.593 MiB above Worker-only |
| Shared-memory Worker growth | 10.969 MiB | 10.984 MiB | no second 256 MiB copy |
| Full-clone RSS growth | 496.344 MiB | 496.344 MiB | read faults parent and writes child |
| Sparse-clone RSS growth | 262.531 MiB | 262.594 MiB | scan faults parent; writes 16 MiB child subset |
| Full-clone elapsed | 34.186 ms | 36.970 ms | copies 256 MiB |
| Sparse-clone elapsed | 85.694 ms | 81.976 ms | scans 256 MiB, copies 16 MiB |

The compiled module is reused in Kandelo's normal fork path, and the measured
module transport increment is tiny relative to a complete large address-space
copy. Sharing the already-touched sparse memory with another Worker adds only
the Worker-scale increment and does not commit another 256 MiB mapping. These
results support the separate-Worker vfork architecture and reject module
churn as the primary cause.

Full clone increases RSS by almost twice the logical memory size in this
synthetic case because the copy reads zero pages from the previously sparse
parent and writes every page in the child. Sparse clone avoids most child
writes and saves about 233.8 MiB relative to full clone, but it still scans and
faults the complete parent mapping and takes 2.22–2.51 times as long. This is a
component measurement, not application evidence. Sparse clone remains
unselected until a real large guest workload shows lower peak RSS without an
unacceptable latency or CPU cost on Node and browsers.

### Current lifecycle measurements

The Node process-lifecycle suite ran three rounds:

```sh
bash scripts/dev-shell.sh npm run bench -- \
  --suite=process-lifecycle --rounds=3
```

| Metric | Median |
|---|---:|
| hello start | 194.61 ms |
| fork + child exit | 52.81 ms |
| exec | 253.48 ms |
| pthread clone | 49.47 ms |
| non-forking posix_spawn | 50.28 ms |

This latency microbenchmark does not reproduce Ruby's memory size or
Homebrew's process count. It proves only the selected artifact paths and their
local medians.

The repository's real Node retirement fixture then ran 48 sequential 8 MiB
children after warm-up. RSS rose from 354.484 MiB to a 482.547 MiB early peak
and ended at 316.563 MiB. Its late slope was -4.674 MiB per child, late growth
was -165.984 MiB, and guest stderr/host diagnostics were empty. That confirms
current exact-fenced generations remain collectible in this run. It does not
remove the pre-reclamation peak that motivates vfork.

The browser process-retirement integration ran 100 real fork/exec iterations
per engine and passed in Chromium, Firefox, and WebKit. This validates the
ordinary fork/exec and retirement path affected by pre-copy admission. It is
not evidence for unimplemented vfork behavior or a browser RSS ceiling.

## Upstream CRuby integration

Kandelo's Ruby package is version 4.0.5 from the checksum-pinned upstream
tarball. Upstream `process.c` already contains the desired selection logic in
`retry_fork_async_signal_safe()` when `HAVE_WORKING_VFORK` is defined:

```c
if (!has_privilege())
    pid = vfork();
else
    pid = rb_fork();
```

`has_privilege()` rejects effective uid 0, uid/gid mismatches, saved-id
mismatches, and `issetugid()`. Thus a normal Kandelo Homebrew process running
as uid 1000 naturally selects upstream vfork for this eligible async-safe
fork/exec path. Root and other privileged shapes intentionally retain
ordinary fork. No Ruby-specific command classification is needed.

The worktree-local SDK already defaults `ac_cv_func_vfork=yes`, but
`packages/registry/ruby/build-ruby.sh` overrides it with
`ac_cv_func_vfork=no`. That override is truthful today because Kandelo's
`vfork()` is only an alias for fork. It must change to `yes` only after the
platform implementation and conformance evidence land in the coordinated ABI
epoch.

PR #1166 adds `kandelo-posix-spawn.patch` and applies it to `process.c`. Its
tests correctly constrain the temporary exception to command shapes that the
current spawn contract can reproduce. That source patch is not part of the
vfork design and must be deleted, not generalized.

## ABI and release impact

Changing `kernel.kernel_fork` from `() -> i32` to `(i32) -> i32` is an
incompatible process ABI change. The coordinated implementation must include:

- an `ABI_VERSION` bump from the active batch's base;
- regenerated `abi/snapshot.json` and generated TypeScript constants;
- libc `_Fork()`/`fork()`/`vfork()` callers with explicit mode constants;
- host import closures for main and pthread Workers;
- side-module `env.fork` mode propagation;
- `ForkLaunchRequest` and Worker-init protocol metadata for vfork, inherited
  process-control offset, and borrowed replay;
- fork-instrument tests proving a parameterized seed call preserves its mode
  through unwind/replay;
- loud rejection of stale ABI 42 programs, packages, and VFS images; and
- rebuild/publish of every ABI-bound kernel, program, package archive, and VFS
  artifact.

As of this record, draft
[PR #1096](https://github.com/Automattic/kandelo/pull/1096) already owns the
ABI 43 activation-state-safe fork epoch, while draft
[PR #1098](https://github.com/Automattic/kandelo/pull/1098) also carries ABI 43
host/kernel work. Brandon must choose the exact agreed base and whether vfork
joins that epoch or follows it. This branch must not independently claim ABI
43 or restack either draft.

The linked continuation descriptor does not need a new serialized field for
borrowed replay, because it already carries `fixed_prefix_size`. The Worker
protocol does need separate addresses for the parent's continuation root and
the child's mutable prefix. The ABI bump is still mandatory: old host
semantics would consume the shared chain and old libc cannot express the mode.

The current pre-copy admission change alters no guest-visible structure,
syscall number, import signature, frame encoding, or host/kernel protocol. Its
`EAGAIN` behavior uses the already-defined fork launch failure path. The ABI
snapshot check must nevertheless run for this series.

## Rejected or deferred alternatives

### Treat every fork as vfork

Rejected. The host cannot know at fork time that a child will exec, and
ordinary child writes must be isolated even when an application later execs.

### Same-Worker sequential child

Rejected in favor of a separate Worker. It entangles channel closures,
instance globals, pthread entry, dynamic-link state, crash containment, and
Worker retirement across two Process identities.

### Sparse exact clone

Deferred. Synthetic RSS improved, but scan time regressed and no real
Homebrew, Node/browser, or cross-engine application result exists.

### Worker or module rotation

Rejected as the primary fix. The measured Worker/module increment is small
beside full clone commitment, current workers already have exact teardown, and
July 30 removed the separate `workerData` retention path. Rotation cannot
provide copy-on-write semantics or remove the eager copy.

### Broader package-specific posix_spawn rewrites

Rejected. Upstream CRuby already exposes the correct vfork selection hook.
Expanding #1166 would move platform policy into a package and still leave
other upstream fork/exec users exposed.

### Software dirty-page tracking

Deferred. Exact dirty tracking would require instrumenting every guest store,
bulk-memory operation, memory growth, and side module consistently, then
proving that a missed write cannot corrupt fork isolation. Sparse scanning is
already costly without that instrumentation.

### Move the active-frame cursor into a new Wasm global

Not required for the selected design. A per-instance cursor would remove the
generated store at offset zero of the module prefix, but it would add another
fork-instrument semantic change during an already active ABI batch. The
module's exact prefix is small relative to its address space, its size is
already declared, and a private copy has passed real separate-Worker replay.
The active ABI work may still choose a global if it simplifies its new frame
model, but vfork must not depend on that larger rewrite.

### Future Wasm memory-control or page-mapping features

Monitor, but do not design current correctness around them. Current browser
WebAssembly has no portable clone or copy-on-write primitive. A future
standardized mapping facility could optimize ordinary fork behind the same
ownership contract.

### Explicit garbage collection or renderer reset

Rejected. Collection timing is not a portable API or correctness boundary.
Resetting a renderer/kernel/Worker would discard legitimate machine state and
would only mask ownership or admission defects.

## PR #1166 removal and proof plan

After the coordinated vfork series is complete:

1. Delete `packages/registry/ruby/patches/kandelo-posix-spawn.patch` and its
   application block from `build-ruby.sh`; do not replace it with another
   Ruby command classifier.
2. Remove tests that assert the Kandelo-only Ruby patch and retain/rewrite
   their useful process semantics as platform vfork tests.
3. Remove the recipe's `ac_cv_func_vfork=no` override so the SDK's truthful
   working-vfork probe enables upstream `HAVE_WORKING_VFORK`.
4. Build from the checksum-pinned upstream 4.0.5 source through the normal
   Kandelo SDK, libc, fork-instrument, package, and ABI path. Verify the source
   tree has no #1166 patch residue.
5. Add an upstream-selection fixture that runs as uid 1000 and proves
   `retry_fork_async_signal_safe()` reaches `SYS_VFORK` with no full memory
   allocation/copy. Run the matched root/privileged fixture and prove it
   reaches ordinary `SYS_FORK` and still clones independently.
6. Exercise failed exec, successful exec, `_exit`, trap/crash, descriptors,
   signals, cwd/credentials, process groups, main/pthread callers, sequential
   repetition, rejected nesting, and dynamic side modules through platform
   tests before using Ruby as application evidence.
7. Rebuild the Ruby package, increment its publish revision/cache key, publish
   it to the ABI-specific binary index, and anonymously resolve the published
   archive. No local unpublished artifact may satisfy the proof.
8. Rebuild the Homebrew VFS/image inputs against that exact Ruby archive and
   verify their ABI metadata and source provenance.
9. Repeat the exact first-party lifecycle: boot the stock mostly-lazy main
   shell as uid 1000, tap the immutable public core revision, verify trust and
   revision, remove the directly composed Bzip2 receipt, install Bzip2 through
   stock `brew`, execute it, and recheck tap/trust state.
10. Record renderer/process-tree RSS throughout the lifecycle in Node and
    Chromium, require completion without renderer loss or history-proportional
    growth, and run the applicable Firefox/WebKit platform lifecycle even
    where the Chromium product proof remains authoritative.
11. Repeat the intentional root/privileged Ruby fallback with enough memory
    headroom to prove ordinary fork behavior independently; do not expect that
    fallback to have vfork's memory profile.

Only after that evidence should #1166's migration exception and documentation
be removed. Until then, this record supports a design, one generic admission
guardrail, and unwired host foundations, not the claim that Homebrew's
fork-then-exec problem is fully resolved.

## Validation recorded for this change

Completed:

- full repository build through `scripts/dev-shell.sh`;
- focused allocator, kernel rollback, Node/browser host-parity, fork-clone,
  and retirement Vitest tests (60 tests), including proof that retirement
  rejection reaches fork as `EAGAIN`;
- 60 current-tree focused host tests covering refcounted backing aliases,
  borrowed linked-frame traversal, transactional prefix validation, real
  instrumented replay in a separate Node Worker, unchanged parent bytes, and
  successful later parent replay;
- 29 focused host lifecycle tests, including 13 shared-vfork coordinator tests
  plus the existing exact Worker-quiescence and process-generation detach
  ledgers;
- the complete CI-shaped `fork-instrument` host-target suite (210 tests), plus
  host declaration generation/typechecking and the VitePress documentation
  build;
- ABI snapshot, C header, and generated TypeScript binding consistency check;
- Node process-lifecycle benchmark, three rounds;
- Node exact-retirement RSS fixture, 48 measured children after warm-up;
- component measurement harness, two independent runs;
- real instrumented main and active-side continuations plus a current-SDK
  wasm-ld side-module borrowed-replay component test in separate module
  Workers on Chromium, Firefox, and WebKit;
- Chromium, Firefox, and WebKit 100-iteration fork/exec retirement test; and
- the current P-08 fork-instrument alias fixture after generating the stale
  baseline package projection for the test only.

A broad host Vitest sweep was also attempted. It completed with 197 of 270
test files passing and 2,288 of 2,314 tests passing, but it was not green:
69 files and 20 tests failed. Failures included the baseline stale
`packages/registry/program-packages.json` source projection and the absent
`sysroot64` fixture prerequisite. That run is recorded as a limitation, not
as completion evidence for this change.

### ABI 43 integration update — 2026-08-01

The borrowed replay foundations were forward-ported onto ABI 43's
process-wide activation journal rather than retaining the earlier per-side
continuation/archive design. Validation through `scripts/dev-shell.sh`
recorded for that forward-port is:

- host declaration generation, typechecking, and the VitePress documentation
  build completed;
- 77 focused dynamic-linker tests passed, including current-SDK wasm-ld
  reconstruction over the parent's shared Memory;
- the ABI 43 Node Worker borrowed-replay test, 37 linked-continuation tests,
  36 module-state tests, 10 activation-registry tests, 9 process-coordinator
  tests, 13 lifetime tests, and 12 dynamic-linker archive tests passed; and
- nine Playwright cases passed: the ABI 43 continuation/manifest proof, the
  wasm-ld no-write proof, and the active-side-continuation proof in Chromium,
  Firefox, and WebKit.

A wider ten-file host run recorded 196 passed tests and one existing
capability skip, but it was not green: six ordinary copied-fork dlopen
end-to-end cases timed out at 30 seconds. A serial rerun of the two cases in
`fork-dlopen-replay-e2e.test.ts` timed out the same way. The same two tests and
the four `fork-from-dlopen-side-module-e2e.test.ts` cases were then run at the
pre-vfork ABI 43 integration commit `992369868`, using the same generated
kernel and sysroots whose source inputs this host-only stack does not change.
The baseline reproduced all six 30-second timeouts; its remaining dlopen test
passed and its C++ capability case was skipped. This rules out the borrowed
replay stack as the source of the observed ordinary-fork failures, but the ABI
43 baseline defect itself remains unresolved. These cases are not completion
evidence for either path.

Still required before a broad vfork or Homebrew completion claim:

- the coordinated ABI snapshot/bump and complete vfork implementation;
- libc, POSIX, Sortix, kernel, host, fork-instrument, ABI, Node, and browser
  conformance suites selected for that implementation;
- vfork-specific failure/rollback and cross-engine tests listed above;
- pristine upstream-selection tests at uid 1000 and privileged uid 0;
- rebuilt and anonymously published Ruby/VFS artifacts; and
- the exact real in-guest Homebrew lifecycle and RSS proof.
