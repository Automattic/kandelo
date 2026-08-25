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

The integration branch now implements that core architecture. This is not yet
a broad release or package-install completion claim: complete conformance
suites, published upstream CRuby artifacts, real resident set size (RSS),
artifact publication, and the exact package-install lifecycle remain explicit
gates.

The independently reviewable implementation now includes:

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
  and ambiguous termination that requires whole-address-space containment;
- ABI 43 activation and dynamic-linker reconstruction can borrow the sealed
  process manifest and parent frame nodes while giving every active main/side
  activation a private prefix and refusing loader-controlled memory writes;
- ABI 43 owns ordinary/vfork mode values, an exact `(i32) -> i32` process
  import, mode-stable capture/replay, a mode-aware kernel export, and symmetric
  Node/browser child-launch metadata;
- the kernel marks the independent Process record created for a vfork
  transaction, rejects nested fork, spawn, and pthread creation with `EAGAIN`,
  and clears the marker only after successful exec replaces the borrowed
  image;
- the production Node and browser hosts launch a separate vfork child Worker
  over an exact alias to the parent's existing Memory without constructing or
  copying a child process Memory;
- private syscall-channel, replay-prefix, reference-codec, loader, and
  continuation-control state prevents the child from overwriting the parked
  parent's control state;
- the asynchronous fork import parks only the calling parent thread through
  failed exec and until successful exec commit or exact
  `_exit()`/signal/trap teardown;
- fork, vfork, non-forking spawn, and supported `SCM_RIGHTS` retain one
  exactly owned mutable OFD state for offsets, status flags, and async owner,
  while directory host iterators remain process-local and replay the shared
  cookie.

Sparse exact cloning reduced resident set size (RSS) in a controlled sparse
memory case, but increased scan/copy time and has no real package-install
result. It is therefore not selected. Worker and module churn were measurable but small
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
  write-free side-module reconstruction;
- `6e71ac438`, ABI 43 main-continuation and wasm-ld reconstruction proofs in
  Chromium, Firefox, and WebKit;
- `6f481ba85`, ABI 43 active-side-continuation borrowing in separate Workers on
  Chromium, Firefox, and WebKit;
- `1a245ddec` through `68d858757`, explicit mode, kernel ownership guards,
  bounded workspace admission, and private borrowed replay state;
- `faef5e3d8` and `903dfa4ea`, truthful admission and shared-memory launch;
- `2d9cc839e` through `7765b75a2`, host-reserved control ownership, stable
  parent anchors, and pthread-safe libc restoration;
- `c19fa2e44` through `43dedc20f`, cross-engine exit, suspension, zero-copy,
  signal, trap, and fatal-teardown proofs;
- `02e2d60a4`, exact shared inherited OFD state;
- `eeb7d50cc`, the Node/browser POSIX process-state fixture; and
- `7961f47a1`, cross-engine compute-running borrower containment.

The connected commits remain individual in the ABI 43 integration train. They
must not be squashed when the umbrella branch is linearized.

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

The July 30 stock package-install measurements in
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

The slot's fork-save page also supplies the child-private replay prefixes
described below, while its otherwise-unused TLS/control page supplies typed
reference and exception codec scratch. Every active main/side prefix must fit
within 61,440 bytes and the page-rounded scratch high-water must fit within
65,536 bytes. Otherwise vfork returns `EAGAIN` before allocating a child PID or
creating a borrower. Version-1 descriptors already give each exact prefix
size; the parent reference transaction now records the capacity high-water
observed while the same generated codecs encode the inherited graph. The
implementation must not assume every possible graph fits merely because normal
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
evidence for safe separate-Worker replay. At that checkpoint it was not yet a
guest-visible vfork process-lifecycle test; the later connected validation is
recorded below.

The host has the corresponding connected process-wide side-module path.
Borrowed dynamic-linker replay reconstructs each complete archive
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
- copies the process-local descriptor/OFD table shell, relinks each inherited
  OFD's mutable offset/status/owner state to the parent's exact object, and
  retains kernel-global backing references;
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

The kernel Process now carries an internal vfork-child marker so operations
that would create ambiguous shared-memory ownership fail before mutation. It
returns `EAGAIN` for:

- another active vfork from the same address space;
- nested vfork or ordinary fork from a vfork child;
- pthread creation by a vfork child; and
- host operations that require allocating another owner for the borrowed
  address space.

Those calls are outside the permitted vfork-child pre-exec use. Returning a
truthful failure is safer than silently treating them as ordinary fork or
allowing channel/control collisions. The production lifecycle fixture covers
sequential vfork calls after the prior child completes.

The marker is set only for the explicit vfork mode, is not inherited through
serialized process state, survives failed exec, and clears only when exec
successfully commits the replacement Process image. Process removal naturally
retires it on `_exit()` or signal death. It is kernel-internal state: no getter,
new export, or additional guest ABI field is needed because the mode-aware
fork export and Rust-owned spawn and clone paths enforce the affected
transitions directly.

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

### Host lifetime coordinator

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
The Node/browser integrations compare it with the current PID registration
before completing the parked channel; this preserves the existing
stale-generation suppression when a sibling pthread execs or exits the parent.
The 13 focused state-machine tests cover an unresolved caller gate
with unrelated event-loop progress, repeated failed exec, all exact terminal
reasons, pre-launch rollback, pre-launch signal death, ambiguous termination,
competing terminal notifications, overlapping/nested `EAGAIN`, distinct
concurrent address spaces, sequential reuse, child-generation reuse rejection,
and stale-parent identity.

Production Node and browser handlers wire the coordinator to the ABI mode and
Process marker. Existing async `onFork` completion is the caller-thread parking
transport, and Worker-quiescence plus exact-generation detach ledgers remain
the source of terminal evidence.

### Test matrix for the vfork series

The broad vfork completion claim remains gated on the following evidence on
Node and the applicable browser hosts:

- no `WebAssembly.Memory` constructor and no full-memory copy occur on vfork;
- a main-thread caller cannot pass the call site before child exec/_exit;
- a pthread caller parks while a sibling parent thread continues;
- the child channel cannot change the caller's pending channel bytes;
- failed exec returns to the child and leaves the parent parked;
- successful exec, `_exit`, caught signal death, trap, and Worker crash each
  settle exactly once and cannot wedge or prematurely resume the parent;
- a fatal signal delivered while the child has no pending syscall contains the
  complete shared address space rather than publishing an unsafe parent return;
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

### Task 21 revalidation — 2026-08-12

At final-head candidate `3f4ea731bca81c42bf3c7f6ae52a0ac837a7d56b`
(tree `215c366f5075a3a9253c86223b8399a4619a313a`), the ordinary-memory
suite passed 63 checks in five files. The RSS fixture explicitly stages its
child executable at the VFS path used by `posix_spawn`; the host executable
map remains a prepared-target preflight only and is not a substitute for that
guest filesystem entry.

Two churn observations, each with four warm-up children and six waves of
eight 8 MiB children, completed with no guest stderr or host diagnostics:

| Observation | Late slope | Late growth |
|---|---:|---:|
| A | -2.061 MiB/child | -69.313 MiB |
| B | -1.335 MiB/child | -40.750 MiB |

The fixture is evidence that exact-fenced retired memories became
collectible under its bounded ordinary allocation pressure. It is not a
promise about the timing of physical memory reclamation.

The component harness was also rerun twice on Apple Silicon macOS with Node
v24.15.0 from the repository dev shell. It used a 256 MiB shared memory with
16 MiB touched:

| Case | Run A | Run B |
|---|---:|---:|
| Worker-only peak RSS growth | 13.469 MiB | 13.328 MiB |
| Module-Worker peak RSS growth | 14.594 MiB | 13.547 MiB |
| Shared-memory Worker growth | 10.984 MiB | 11.109 MiB |
| Full-clone RSS growth | 496.374 MiB | 496.345 MiB |
| Sparse-clone RSS growth | 262.844 MiB | 262.656 MiB |
| Full-clone elapsed | 33.442 ms | 32.838 ms |
| Sparse-clone elapsed | 76.602 ms | 79.343 ms |

Worker and module churn remain small beside a complete address-space clone.
Sparse clone reduces component RSS in this artificial sparse workload, but it
still scans the complete parent and was 2.29–2.42 times slower than the full
clone. It remains unselected: component results alone are not real product or
cross-host application RSS evidence. The current admission thresholds and
bounded fallback remain allocation-accounting safeguards, not a claim that an
engine physically reclaimed bytes at a particular instant.

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

This latency microbenchmark does not reproduce Ruby's memory size or a package
install's process count. It proves only the selected artifact paths and their
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
not evidence for the later connected vfork behavior or a browser RSS ceiling.

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
mismatches, and `issetugid()`. Thus a normal Kandelo user process running
as uid 1000 naturally selects upstream vfork for this eligible async-safe
fork/exec path. Root and other privileged shapes intentionally retain
ordinary fork. No Ruby-specific command classification is needed.

The ABI 43 integration recipe now supplies truthful working-vfork cache
answers, retains `HAVE_VFORK` and `HAVE_WORKING_VFORK`, and removes the
temporary `kandelo-posix-spawn.patch`. The checksum-pinned source tree still
receives Kandelo's unrelated portability edits and library-root patch, but
upstream `process.c` is no longer modified. Recipe assertions reject both
residue from PR #1166 and a configuration that does not enable the upstream
vfork branch.

The first clean configure exposed an independent cross-probe error. The
recipe had disabled `getresuid()` and `getresgid()` while accidentally
allowing CRuby's AIX-only `getuidx()` and `getgidx()` fallback to be detected
from the build host. Kandelo libc and the kernel already implement the two
POSIX saved-ID queries, so the recipe now reports those functions as present
and the AIX interfaces as absent. No Ruby or libc source workaround was
added.

## ABI and release impact

Changing `kernel.kernel_fork` from `() -> i32` to `(i32) -> i32` is an
incompatible process ABI change. The current ABI 43 integration checkpoint
includes:

- the batch's `ABI_VERSION` 43 selection;
- regenerated `abi/snapshot.json` and generated TypeScript constants;
- libc `_Fork()`/`fork()`/`vfork()` callers with explicit mode constants;
- host import closures for main and pthread Workers;
- mode-stable main/pthread capture, replay, and abort replay;
- `ForkLaunchRequest` and Worker-init mode metadata in both hosts;
- host-intercepted `SYS_VFORK` arguments 0 and 1 carrying the measured replay
  prefix and codec-scratch bytes, with bounded pre-PID admission;
- a mode-aware `kernel_fork_process(parent, caller, mode)` export; and
- exact artifact admission for the parameterized process import.

The connected implementation now includes child-private process control,
borrowed Node/browser replay, parent-caller suspension, exact terminal
release, and side-module and nested-call failure proofs. Release still
requires broad stale-artifact rejection evidence plus rebuild and publication
of every ABI-bound kernel, program, package archive, and VFS artifact.

The selected integration branch combines drafts
[PR #1096](https://github.com/Automattic/kandelo/pull/1096) and
[PR #1098](https://github.com/Automattic/kandelo/pull/1098) with the accepted
ABI 43 batch. This is development and review composition, not merge approval;
kernel, ABI, libc, host, and fork-instrument changes still require Brandon's
explicit approval before merge.

The linked continuation descriptor does not need a new serialized field for
borrowed replay, because it already carries `fixed_prefix_size`. The Worker
protocol does need separate addresses for the parent's continuation root, the
child's mutable prefixes, and its codec scratch. The intercepted syscall now
carries exact byte requirements, but no new linked-frame field, syscall number,
kernel import, export, or ABI snapshot entry is required. The ABI bump is still
mandatory: old host
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
package-install, Node/browser, or cross-engine application result exists.

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

The local integration branch has completed steps 1 through 5 below. They are
implementation evidence, not authorization to merge or publish the removal.

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
   reaches ordinary `SYS_FORK`; retain the platform's independent ordinary
   fork isolation tests alongside that selection proof.
6. Exercise failed exec, successful exec, `_exit`, trap/crash, descriptors,
   signals, cwd/credentials, process groups, main/pthread callers, sequential
   repetition, rejected nesting, and dynamic side modules through platform
   tests before using Ruby as application evidence.
7. Rebuild the Ruby package, increment its publish revision/cache key, publish
   it to the ABI-specific binary index, and anonymously resolve the published
   archive. No local unpublished artifact may satisfy the proof.
8. Rebuild the package-install VFS/image inputs against that exact Ruby archive
   and verify their ABI metadata and source provenance.
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

The recipe removal must not be merged or published until the remaining
platform, publication, and lifecycle gates support it. Until then, this
record supports the connected platform implementation and ordinary-fork
admission guardrail, not the claim that the package-install fork-then-exec
problem is fully resolved.

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

Still required before a broad vfork or package-install completion claim:

- libc, POSIX, Sortix, kernel, host, fork-instrument, ABI, Node, and browser
  conformance suites selected for the connected implementation;
- pristine upstream-selection tests at uid 1000 and privileged uid 0;
- rebuilt and anonymously published Ruby/VFS artifacts; and
- the exact real in-guest package-install lifecycle and RSS proof.

### Selected ABI 43 batch validation — 2026-08-01

The selected non-package-install PR batch, PRs #1096 and #1098, the borrowed-replay
foundation, and PR #947 were composed on
`integration/abi43-batch-20260731`. The frozen sources, history rule, and next
implementation steps are recorded in
`docs/plans/2026-08-01-abi-43-batch-plan.md`.

The latest broad host run through `scripts/dev-shell.sh` recorded 4,027 passed,
five failed, and 130 skipped tests out of 4,162. Every failure was an explicit
missing complete ABI 43 program-artifact closure in the run-example credential
or resolver fixtures. The exact 4,096-child `posix_spawn` churn passed in that
same concurrent run.

An earlier concurrent run had terminated a churn child with signal 11. Added
diagnostics identified a test-only ownership race: the installed-host-package
test ran tsup in the shared checkout, whose clean step removed
`host/dist/worker-entry.js` while the churn machine was launching its next
Worker. Building that package in a private temporary source tree removed the
race; this was not evidence of kernel stack loss, renderer OOM, or incorrect
fork admission.

At this batch-validation checkpoint, the guest-visible vfork mode was distinct
but genuine vfork remained unimplemented. The mode reached
`SYS_VFORK`, Rust, and symmetric Node/browser launch metadata while still
using a full copied child Memory. Rust marked that child's Process record,
rejected nested process/thread ownership, and cleared the marker after
successful exec; failed exec intentionally left it set. The process Worker
also published exact prefix/scratch requirements, and the centralized host
rejected an oversized one-slot workspace with `EAGAIN` before child PID
allocation. No result above should be read as proof of parent suspension,
zero-copy vfork launch, terminal host cleanup, or pristine upstream Ruby
selection.

### Connected vfork and OFD validation — 2026-08-01

Subsequent purpose-scoped commits connected the admitted mode to production
shared-memory launch, caller suspension, private child replay/control state,
and exact terminal teardown on both hosts. A production guest also exposed a
generic inherited-open-file-description defect: Kandelo preserved `OfdId` but
copied mutable offset/status/owner fields. The kernel now retains those fields
in an exactly owned shared state object and reconstructs process-local
directory iterators at one shared cookie.

All commands supporting the following claims ran through
`scripts/dev-shell.sh`:

- the full kernel suite passed 1,522 unit tests, four integration tests, and
  six doc tests;
- focused kernel tests proved shared fork/vfork OFD lifetime, shared directory
  cookies, and post-send `SCM_RIGHTS` mutation/lifetime behavior;
- `bash scripts/check-abi-version.sh` passed native and wasm32/wasm64 layout,
  kernel Wasm export, generated C/TypeScript, snapshot, and version checks;
- `bash build.sh` completed. Because the unpublished ABI 43 release index
  returned 404, the resolver rebuilt its verified-source package closure and
  produced `host/wasm/rootfs.vfs` at 16,787,687 bytes;
- the production Node lifecycle suite passed five cases: repeated `_exit()`
  and failed/successful exec, pthread caller suspension with a runnable
  sibling, exact trap/self-`SIGKILL` teardown, and independent POSIX Process
  state with a shared OFD, plus sibling-delivered `SIGKILL` while the borrower
  was in a no-syscall compute loop;
- the same five cases passed in Chromium, Firefox, and WebKit, for 15 browser
  cases total; and
- the declared program build rebuilt P-08 with ABI 43 instrumentation, and its
  focused production-host case passed (one selected, 50 skipped).

Focused allocation assertions and the pthread fixture's already-exhausted
post-growth process-memory budget prove that the vfork launch retained the
existing Memory rather than constructing or copying a child process Memory.
Output ordering proves that the caller did not pass the vfork call site before
the terminal boundary, while the sibling-thread fixture proves that unrelated
parent pthreads remained runnable. The process-state fixture covers descriptor
flags/close isolation, shared seek position, cwd, credentials, process group,
and wait/reaping. The lifecycle fixture covers failed exec coherence,
successful exec release, sequential calls, and nested fork/vfork/pthread
`EAGAIN`.

This is still not broad completion evidence. The external-signal case proves
the documented browser boundary: a compute-running borrower has no generally
available Worker quiescence fence, so the safe fallback is loud
whole-address-space containment rather than parent resumption. The complete
fork-instrument run is blocked by the stale/rejected `programs/sh.wasm`
artifact closure. A libc vfork runner timed out, and a direct `/bin/sh` exec
attempt reported an exec-format error; neither is recorded as a libc pass. The
development shell did not provide `cargo fmt`, so no formatting-pass claim is
made. Complete libc, POSIX, Sortix, host, browser, fork-instrument,
performance/RSS, artifact-publication, and package-install lifecycle proofs
remain outstanding.

### Upstream CRuby selection and patch removal — 2026-08-01

The Ruby 4.0.5 recipe now removes PR #1166 rather than broadening it. Its build
revision is 14, its source marker rejects a work directory that contains the
retired patch, and its configure contract requires upstream working-vfork
selection plus Kandelo's real `getresuid()` and `getresgid()` support.

A clean build used the official checksum-pinned tarball with SHA-256
`7d6149079a63f8ae1d326c9fa65c6019ba2dc3155eae7b39159817911c88958e`.
The generated configuration contained `HAVE_VFORK`,
`HAVE_WORKING_VFORK`, and `HAVE_WORKING_FORK`. The recipe compiled upstream
`process.c`, linked Ruby, applied local-root spilling and ABI 43 fork
instrumentation, and staged both declared outputs through the sealed package
installer. The 23 MiB executable had SHA-256
`7d6bedf59930881b7f87bad8c9ab78a1b93816d4b0bdba60ec949c497a12851f`
in two builds.

The first final-install attempt found an integration seam: WABT 1.0.36 could
not decode the modern typed-reference entries emitted by the ABI 43 tools,
although Node/V8 compiled the module. The fail-closed guard was not bypassed.
The existing wasmparser-backed artifact decoder now inventories reserved
`env.__wasm_posix_*` imports structurally, retains WABT only as a source-only
fallback, and rejects decoder failure. Its 14 focused Rust tests and the
complete shell artifact-guard suite passed before the package build was
repeated.

The extracted runtime ZIP contents were identical across the two builds, but
the ZIP container SHA changed because its entry timestamps were not
normalized. No byte-reproducibility claim is made for that archive; one exact
rebuilt archive must be selected and bound when publication is authorized.

The exact local executable then passed three production Node cases. At uid
1000, failed exec returned `ENOENT` and successful exec replaced the child
while a memory ceiling equal to Ruby's initial address space admitted vfork.
At uid 0, upstream CRuby intentionally selected ordinary fork; both its first
attempt and garbage-collection retry were rejected before a full child clone
by the same ceiling. The uid-1000 failed-exec case also passed in Chromium,
Firefox, and WebKit. Chromium additionally passed successful exec and the
root fallback, for four passing Playwright cases and two intentional
cross-engine skips.

No artifact was published, no package-install image was rebuilt, no real
install lifecycle was run, and no application RSS claim was measured. Those remain
release gates along with the broad suites listed above.

### Broad validation and current performance — 2026-08-01

The remaining locally runnable conformance gates were then run through
`scripts/dev-shell.sh` against commit `5c0455db6`:

- the CI-shaped host run passed 339 files and skipped 28; it recorded
  4,131 passing tests, two expected failures, and 129 skips, including
  the three upstream Ruby selection cases;
- the JavaScriptCore/Bun teardown and pthread supplement passed three
  tests in two files;
- libc recorded 303 passes, zero failures, 20 expected failures, and one
  passing flaky case out of 324;
- POSIX recorded 174 passes, zero failures, three expected failures, and
  two skips out of 179;
- Sortix recorded 5,037 passes, zero failures, 23 expected failures, and
  53 skips out of 5,113;
- the Rust workspace gate completed successfully, including 1,522 kernel
  tests, four pointer-contract tests, 13 root-spill tests, 48 shared-ABI
  tests, fork-instrument, and documentation tests;
- `xtask` passed 639 unit tests and its cache-root integration test; and
- the ABI gate again matched native, wasm32, and wasm64 layouts, the
  committed snapshot, generated C and TypeScript bindings, and the
  42-to-43 bump.

The focused browser vfork lifecycle remained green in Chromium, Firefox,
and WebKit: five cases per engine, 15 total. The upstream Ruby browser
proof recorded four passes and two intentional cross-engine skips. The
full product browser suite could not start with a complete asset
closure: the ABI 43 release index at `binaries-abi-v43/index.toml`
returns HTTP 404, and the local tree has no accepted ABI 43 application
package set.
Substituting ABI 42 artifacts would violate the artifact and ABI
contracts, so no such fallback was used.

The component RSS harness was repeated twice against the final
64,151-byte ABI 43 `fork-bench.wasm`:

| Case | Run A | Run B |
|---|---:|---:|
| Worker-only peak RSS growth | 13.063 MiB | 13.453 MiB |
| Module-Worker peak RSS growth | 13.500 MiB | 13.172 MiB |
| Shared-memory Worker RSS growth | 11.094 MiB | 11.156 MiB |
| Full-clone RSS growth | 496.344 MiB | 496.344 MiB |
| Sparse-clone RSS growth | 262.656 MiB | 262.641 MiB |
| Full-clone elapsed | 35.287 ms | 35.338 ms |
| Sparse-clone elapsed | 95.125 ms | 79.470 ms |

The final artifact therefore reproduces the architectural result:
sharing an existing 256 MiB Memory adds Worker-scale RSS, while a
complete clone adds 496.344 MiB in this sparse-parent experiment. Sparse
cloning saves RSS but still faults and scans the parent and takes
2.25 to 2.70 times as long. This remains component evidence, not a
package-install application RSS result.

All three self-contained benchmark suites ran for three rounds on Node
and Chromium. The final medians included:

| Host and suite | Selected medians |
|---|---|
| Node process lifecycle | hello 271.00 ms; fork 79.54 ms; exec 337.81 ms; clone 64.38 ms |
| Chromium process lifecycle | hello 373.20 ms; fork 41.00 ms; clone 28.00 ms |
| Node spawn scratch | spawn 74.50 ms; large first 70.69 ms; repeat 69.54 ms |
| Chromium spawn scratch | spawn 33.00 ms; large first 28.00 ms; repeat 26.40 ms |
| Node syscall I/O | pipe 62.37 MiB/s; syscall 27.30 us |
| Chromium syscall I/O | pipe 58.82 MiB/s; syscall 32.00 us |

The spawn scratch shape retained exactly 84,386 bytes and ended with
17,760,256 kernel bytes on both hosts. The all-suite gates stopped
before any workload because Node lacked ABI 43 PHP, WordPress, and both
MariaDB architectures. The browser lacked the WordPress and two MariaDB
VFS images. No broad application-performance or no-regression claim is
made.

A same-day rebuild of pre-batch commit `2f5b3c411` confirmed a real
lifecycle regression in the combined ABI train:

| Metric | Pre-batch | Final | Change |
|---|---:|---:|---:|
| hello start | 190.10 ms | 271.00 ms | +42.6% |
| fork and child exit | 53.01 ms | 79.54 ms | +50.0% |
| exec | 234.43 ms | 337.81 ms | +44.1% |
| pthread clone | 46.92 ms | 64.38 ms | +37.2% |

Seven-run empty-VFS phase measurements separated the broad ABI batch
from the later vfork commits:

| Revision | Kernel-host init | Hello process launch |
|---|---:|---:|
| pre-batch `2f5b3c411` | 127.584 ms | 51.401 ms |
| pre-vfork ABI 43 `40992ab95` | 177.738 ms | 72.726 ms |
| final `5c0455db6` | 181.967 ms | 74.367 ms |

The generated kernel Worker grew from 1,162,219 bytes before the batch
to 2,028,243 bytes before vfork and 2,055,252 bytes in the final tree.
The process Worker grew from 219,027 to 978,422 to 993,077 bytes. The
pre-vfork ABI 43 checkpoint therefore already contains about 39 to 42
percent of the empty-VFS regression; the connected vfork stack adds
about 2.3 to 2.4 percent on top. This does not make the broad regression
acceptable, but it rejects vfork as its primary cause and keeps the
integration train bisectable for a separate startup-size investigation.

Artifact publication remains the release boundary. Until the exact
ABI 43 Ruby, shell, and application closure is published, neither the
complete browser benchmark matrix nor the real in-guest package install
and RSS lifecycle can be claimed.
