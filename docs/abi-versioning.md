# ABI versioning

User programs are compiled against the kernel's binary interface. When the
kernel changes that interface in a way that breaks old binaries, running an
old binary against a new kernel would silently corrupt state. To prevent
this, the project maintains:

1. A single integer [`ABI_VERSION`](../crates/shared/src/lib.rs) that every
   compiled binary carries and the kernel exports.
2. A structural snapshot of the ABI surface at
   [`abi/snapshot.json`](../abi/snapshot.json), regenerated from source.
3. A CI check that refuses to let the snapshot drift from source, and
   refuses no-bump snapshot changes unless they are narrowly additive.

**Agents and humans alike: do not change the kernel ABI incompatibly
without bumping `ABI_VERSION`.** The check is structural, not a
convention — CI enforces it.

## ABI staging rollout status

The checked-in ABI staging foundation is local and inert. It defines strict,
canonical data contracts for VFS products, consumer selection, staging
requests and records, guard policy, builder inputs and reports, and legacy
retirement conditions. The miniature fixture exercises those contracts with
ABI values read from fixture data and requires an exact generic `N` to `N + 1`
transition; the reusable implementation contains no concrete ABI number.

The local proof builds from the exact declared PR-head identity, derives
Formula roots from selected VFS products, preserves embedded and lazy
materialization, publishes into isolated content-addressed fixture
namespaces, verifies through an anonymous reader, promotes unchanged layer
bytes, and recomposes the final VFS with canonical references. It also proves
that prior-ABI history must be protected and verified before successor
promotion and that incomplete Pages inventory retains the last complete
local site.

The next checked-in layer derives a request only from an exact same-repository
pull-request head. Its current identity is the complete tuple of head,
requirements digest, request-policy version and digest, and guard-registry
version and digest. A later policy issuance for the same head appends a new
content-addressed request; it does not overwrite or invalidate the earlier
request. Request assets use
`candidate-request-<full-head-sha>-sha256-<request-digest>.json`.

Request publication and tap reconciliation both remain in `observe` mode.
The Kandelo workflow has no Release write while that mode is active. The tap
workflow anonymously validates public GitHub data and reports deterministic
pull-request lifecycle decisions, but cannot dispatch builds or write package,
branch, or Check state. The local cross-repository fixture proves derivation,
append/no-clobber behavior, policy reissuance, pull-request advance, historical
head completion, close, reopen, and merge handling without using the network.

Neither workflow revision has reached protected `main`, and there is no hosted
canary evidence for this layer. It therefore does not currently issue hosted
requests, execute candidate code, publish candidate or canonical artifacts,
update a GitHub Check, create or protect an ABI branch, or deploy Pages. Those
operations require the later staging layers and their hosted evidence.
Existing ABI release and VFS behavior is unchanged.

## What counts as an ABI change

Anything that could make an old compiled binary misbehave against a new
kernel. Specifically, any of the following requires an `ABI_VERSION` bump:

- Removing, renaming, or reassigning a syscall number.
- Changing an existing syscall argument descriptor used by the host for
  pointer marshalling, including direction, size source, multipliers,
  fixed byte lengths, pointer nullability/requiredness, or return-value copy
  adjustments.
- Changing the channel header layout (field offsets or sizes in
  [`crates/shared/src/lib.rs`](../crates/shared/src/lib.rs)
  `channel` module).
- Changing the data-buffer size or the signal-delivery area layout.
- Adding, removing, or reordering fields of a marshalled `repr(C)` struct
  (`WasmStat`, `WasmDirent`, `WasmFlock`, `WasmTimespec`, `WasmPollFd`,
  `WasmStatfs`), or changing a field's type in a way that shifts offsets
  or span.
- Changing the required `wpk_fork_*` export names or the save-buffer /
  frame format emitted by
  [`wasm-fork-instrument`](fork-instrumentation.md) into every
  fork-using user program. The kernel does not read these exports
  directly, but the host runtime in `host/src/worker-main.ts` does —
  a rename here silently breaks fork for every already-built binary.
- Changing the linked musl/glue syscall function types or argument-slot widths,
  including the wasm32 cancellation-point `__syscall_cp` path. These are not
  currently visible in the structural snapshot, but stale objects and archives
  can otherwise link with incompatible Wasm function signatures.
- Adding or changing a required kernel-Wasm host import. Kernel imports are not
  yet present in the structural snapshot, so reviewers must track this surface
  explicitly and coordinate the host implementation in the same ABI epoch.
- Changing the name, version, encoding, or role semantics of the
  `kandelo.wpk_fork.capabilities` custom section. The host uses these claims to
  decide whether a main/side-module pair can safely coordinate fork replay and,
  in ABI 43, whether the artifact satisfies activation-state ownership.
- Renaming the ABI custom section or the process-expected globals.
- Changing the meaning of a syscall argument, errno, or blocking
  behavior without changing its signature. **This is not caught
  structurally — reviewers must flag it and bump anyway.**

The fork-capability section has an explicit ABI transition rule. ABI 16 accepts
an absent section through the pre-existing five-export fallback, while treating
a present marker as authoritative. ABI 17 was intentionally skipped; ABI 18
was the first epoch above 16 and made the role marker mandatory. ABI 43 adds
`FORK_CAP_ACTIVATION_STATE_SAFE` and requires it on every fork-instrumented
main or side module. An ABI 42 artifact does not become ABI 43-compatible by
copying the new capability byte: the embedded ABI version and the capability
contract are validated together.

ABI 26 also makes `kernel_get_process_exit_signal` a required host-adapter
export. The host uses the query unconditionally to distinguish signal death
from ordinary high exit statuses, so a kernel without it must fail manifest
validation rather than silently treating the process as live.

ABI 31 makes `kernel_prepare_write_operation` required. Host-backed writes use
that preflight unconditionally before splitting one guest operation into
scratch-buffer chunks, so a kernel without it must fail manifest validation
rather than bypassing operation-wide file-size enforcement.

ABI 39 makes `kernel_posix_timer_fire` required. The host uses it for every
host-scheduled POSIX timer expiration so the kernel can preserve exact
`SIGEV_THREAD_ID` targets, `SI_TIMER` metadata, overruns, and signal-wait wake
selection. A kernel without it must fail manifest validation rather than fall
back to process-wide delivery.

ABI 40 moves advisory file-lock authority into the Rust kernel. It removes the
required `host_fcntl_lock` import and the public host-package `SharedLockTable`
API, distinguishes lock conflicts (`EAGAIN`) from bounded-manager exhaustion
(`ENOLCK`), and adds exact `FileId` plus machine-wide `OfdId` state to fork/exec
serialization version 12. Kernels, hosts, libc, guest programs, packages, and
VFS images from ABI 39 must be rebuilt rather than mixed with ABI 40 artifacts.

Pure internal refactors (renaming a kernel-side function, reorganizing
a source file, tightening a bound in a non-ABI type) are *not* ABI
changes and do not require a bump.

The following snapshot changes are backward-compatible additions and do
not require an `ABI_VERSION` bump:

- Adding a new named syscall number while leaving every existing syscall
  entry unchanged.
- Adding a new host-intercepted syscall number while leaving every
  existing host-intercepted entry unchanged.
- Adding a new kernel-wasm export while leaving every existing export's
  kind, signature, type, mutability, and tracked value unchanged.
- Adding a new marshalled struct name while leaving every existing
  marshalled struct layout unchanged.
- Adding a syscall argument descriptor for a syscall that previously had
  no descriptor, while leaving every existing descriptor unchanged.
- Adding the initial `host_adapter` snapshot section or adding new
  optional host-adapter metadata while leaving required existing fields
  unchanged.
- Adding a new named VFS metadata category, such as `statfs_flags`, while
  leaving every existing VFS metadata category unchanged.

These additions still require regenerating and committing
`abi/snapshot.json`. They do not permit older kernels to run newer
programs that require the new surface; they only permit older programs
to keep running on newer kernels in the same `ABI_VERSION` epoch.

### ABI 41 fork-continuation reserve

ABI 41 increases each fork-continuation save buffer from 16 KiB to 60 KiB.
The reserve occupies the upper part of an existing 64 KiB scratch page and
leaves a 4 KiB prefix for host-owned control metadata. It covers the measured
49,232-byte Bash continuation with 12,208 bytes of headroom while
retaining truthful post-unwind detection for continuations above the fixed
bound.

The host passes the buffer's absolute address to every instrumented main
module, pthread worker, and fork-capable side module; neither that address nor
the capacity is baked into instrumented code. ABI 39 and 40 programs still need
rebuilding because the public process-memory layout belongs to ABI 41. ABI 41
candidate programs created before publication remain mechanically valid when
only this host-supplied reserve grows and the frame format stays unchanged.

### ABI 42 kernel-owned task identities and scalable fork continuations

ABI 42 makes the Rust `ProcessTable` the sole authority for process and thread
identities. One monotonically increasing positive signed task-ID sequence starts
at 100 and serves top-level process creation, fork, non-forking `posix_spawn`,
and thread-style clone. IDs are not reused after process reaping or thread exit;
allocating `i32::MAX` succeeds, and only the following allocation returns
`EAGAIN`. PID 1 is created separately as the synthetic init reservation and
never names a user Wasm worker.

The kernel implementation enforces that ownership with a linear
`AllocatedTaskId`: only `ProcessTable` can mint one, and production `Process` or
`ThreadInfo` construction consumes it. PID, TID, and thread-membership views are
not mutable outside that path. Caller-selected constructors remain test-only,
and fork deserialization restores non-identity state into an already-authorized
child instead of constructing a PID from serialized or host input. These are
internal Rust invariants rather than additional Wasm exports.

The kernel creation exports now return their assigned identities:
`kernel_create_process()` takes no PID, and
`kernel_create_process_with_stdio(stdin_kind, stdout_kind, stderr_kind)` takes
only stdio kinds. `kernel_fork_process(parent_pid, caller_tid)` takes no child
PID and returns the allocated child. The new
`kernel_spawn_process(parent_pid, caller_tid, blob_ptr, blob_len)` signature
likewise names the already-existing calling task, not a proposed child
identity. The kernel validates that `caller_tid` is the parent's live main task
or one of its live kernel-allocated threads before either operation; an unknown,
stale, or cross-process caller returns `ESRCH`. The caller-selected
`kernel_init(pid)` and `kernel_init_from_fork(..., child_pid)` constructors are
removed. Host `createProcess` asks the kernel for an identity, while
`registerProcess` only attaches memory, channels, and worker metadata to
existing kernel state; no host allocator or task-ID watermark remains.
Thread-style clone likewise validates its bound caller against the owning
process before consuming a task ID. The host adapter manifest and kernel
artifact gates require the create, fork, spawn, exact exec, and thread-exit
exports, so a stale kernel cannot defer a missing authority or lifecycle path
until the first child, exec, or thread exit.

Exec is an exact-caller two-step operation. The required
`kernel_exec_prepare(pid, caller_tid)` export validates the live task and
applies deferred file actions before the irreversible transition. The required
`kernel_exec_setup_for_thread(pid, caller_tid)` export performs the in-place
exec reset while preserving the calling task's mask and directed signal state.
The required `kernel_thread_exit(pid, tid)` export removes only that process's
exact live thread; unknown, already-exited, and cross-process TIDs return
`ESRCH` rather than falling back to a host-side lifecycle decision.

Fork and spawn use the validated caller identity to select the calling task's
blocked signal mask. A fork child inherits that mask, and a spawn child inherits
it unless `POSIX_SPAWN_SETSIGMASK` supplies a replacement. The obsolete
`kernel_reset_signal_mask` export is removed; clearing the fork child's mask in
the host would violate pthread-fork semantics. On the child rewind path, libc
refreshes the copied pthread TID from the kernel through `set_tid_address`
before returning from `fork()`.

Channel identity binding is kernel-validated in the same epoch.
`kernel_set_current_tid(pid, tid) -> 0 | -errno` replaces the former unchecked
one-argument setter. It accepts only the process's main task or a thread that
the same `ProcessTable` has already allocated for that process; a host cannot
invent a TID or bind one process's channel to another process's task. The
read-only `kernel_validate_task(pid, tid)` export lets the host validate channel
registration without installing dispatch authority. Clone callbacks attach a
mailbox by consuming a one-shot host transport proof whose immutable PID/TID
pair comes from that exact kernel clone result. The public attachment path does
not accept a numeric TID, and rejects proof replay, duplicate offsets, duplicate
TID ownership, and attempts to substitute a different valid sibling task. A
successful `kernel_set_current_tid` binding authorizes exactly one
`kernel_handle_channel` call and is cleared after every return. Because
the reusable kernel's exit transaction returns through the dispatcher, its
normal epilogue restores the kernel shadow stack and clears that binding. The
separate guest `kernel_exit` import traps only after the host completes the
exit-channel handshake, preserving `_exit`'s non-returning program contract
without trapping the reusable kernel instance. Missing, rejected, stale, or
exited task bindings fail closed with `ESRCH`; no PID-only ambient selector
remains.

ABI 42 host runtimes also accept the deliberate trap emitted by older ABI 42
kernels after a committed exit, but still require authoritative `Exited` state
before publishing success. This preserves old/new host-kernel compatibility
while fixed kernels return through their shadow-stack epilogue.

All host-initiated guest mutations that previously depended on such a selector
now carry their authority explicitly. `kernel_dequeue_signal(pid, tid,
out_ptr, out_capacity)`, `kernel_wait_child_poll(parent_pid, caller_tid,
target_pid, event_mask, flags, out_ptr, out_capacity)`, and
`kernel_prepare_write_operation(pid, tid, fd, offset, len, positioned)`
validate the exact live caller before consuming signal or wait state or
applying write-limit side effects. Guest SysV shared
memory calls use `kernel_ipc_shmat_for_task(pid, tid, ...)` and
`kernel_ipc_shmdt_for_task(pid, tid, ...)`; lifecycle-only inheritance,
rollback, and teardown use the separate explicit-process
`kernel_ipc_shmat_for_process` and `kernel_ipc_shmdt_for_process` exports.
The former `kernel_set_current_pid` export is removed.

ABI 43 also moves host-bridged TCP listener selection into the process table.
`kernel_pick_tcp_listener_target(port, exclude_pid, out_ptr, out_capacity)`
writes one little-endian `{ u32 pid, i32 fd }` record into eight bytes of kernel
scratch when `out_capacity` is exactly eight and returns `1`, returns `0` when
no live listener exists, or returns a negative errno. Rust filters
authoritative process, descriptor, open-file-description, and socket state and
owns the per-port round-robin cursor. The
shared Node/browser host retains only the platform listener objects, stable
accept-wakeup identities, and their lifecycle mirrors.

Process teardown in ABI 43 also consumes platform-timer cleanup from Rust via
`kernel_take_process_timer_cleanup(pid, out_ptr, out_capacity)`. Each bounded
little-endian list begins with `{ u32 cancel_alarm, u32 posix_count }` and is
followed by `posix_count` timer IDs. Rust clears exactly those process-owned
identities before a parent can reap the zombie; the shared Node/browser host
uses the detached list only to cancel its `setTimeout`/`setInterval` handles.
An oversized list returns `ERANGE` without consuming any Rust state. The host
may use its remaining handle maps only at that bounded-output fallback or after
Rust reports `ESRCH`, which is the explicit post-reap worker-detachment
boundary.

ABI 43 publishes the existing kernel wake stream as the generated
`wakeup_event_wire` contract. Each packed record is five bytes: a
little-endian `u32` identity followed by a one-byte reason bitset. Rust owns
the offsets and the readable, writable, accept, datagram-writable,
process-stopped, process-continued, and advisory-lock bits. The shared
Node/browser host decodes the stream only through generated constants before
rescheduling its platform-owned retry queues. This metadata adds no extra
host-to-kernel call; it makes the already-observable stream explicit in the
ABI snapshot.

`kernel_take_pty_readiness_changed() -> u32` is an additive kernel export.
It returns 1 once for coalesced PTY queue/mode/hangup readiness changes, then
0 until another change occurs. It adds no fields or reason bits to the packed
wake stream and changes no guest syscall signatures or layouts. Existing
hosts retain their readiness retry timers; updated hosts consume the
notification under the same entry gate as the packed stream. The existing
ABI version is retained because guest calling conventions remain compatible.
The strict snapshot-digest gate still requires artifacts stamped against the
previous snapshot to be rebuilt through the normal package/fixture path.

The pending ABI 43 contract additionally makes the Rust `Process` authoritative
for each System V shared-memory attachment's process address, segment id, and
size. After the host has materialized an attachment and its byte-coherence
mirror, it commits that identity through
`kernel_ipc_shm_record_mapping_for_task(pid, tid, addr, shmid, size)`. Fork
materialization uses the corresponding `for_process` form because the child
does not have a running guest task yet. `shmdt` first calls
`kernel_ipc_shm_lookup_mapping_for_task(pid, tid, addr)`, whose nonnegative
`i64` result packs the size in the upper 32 bits and shmid in the lower 32
bits; negative values are negated errno values. After publishing dirty bytes,
the host calls `kernel_ipc_shmdt_addr_for_task`; lifecycle rollback and teardown
use `kernel_ipc_shmdt_addr_for_process`. The older segment-id detach export is
used only to roll back a `shmat` that acquired `nattch` but failed before an
address record could be committed.

These address records are not serialized in the ordinary fork wire image.
The existing host inheritance transaction records each child attachment only
after `shmat` succeeds and rolls back by exact address before publishing child
bytes. Successful exec drains the records and decrements `nattch` in Rust at
the irreversible image commit; failed exec leaves both records and host byte
mirrors intact. Process removal provides the final Rust-owned cleanup path.
The host mirror remains necessary because separate WebAssembly memories do not
share physical bytes, but it no longer determines attachment identity or
lifetime.

The Rust kernel Wasm's obsolete direct `kernel_fork` export and its
host-supplied `host_fork` and `host_clone` imports are also removed. Guest libc
still imports `kernel_fork` from its process-worker adapter; that adapter routes
the request through the centralized host, which calls
`kernel_fork_process(parent_pid, caller_tid)` and uses the PID returned by
`ProcessTable`.

Exact-thread signal delivery is strict in ABI 42. `tkill` and `tgkill` deliver
only to a retained live task record in the calling process. TID 0 and unknown
or exited TIDs return `ESRCH`; they are not reinterpreted as process-wide
signal requests. Cross-process exact-thread delivery remains unsupported.
Machine-wide `kill` target selection, including process groups and `kill(-1)`,
now runs entirely against `ProcessTable`; the former `host_kill` import and
host-side `DeliverSignalMessage` routing path are removed.

These removals and signature/return-semantics changes, including task
creation, `kernel_set_current_tid`, signal dequeue, child wait, write prepare,
SysV attachment, exact exec, and exact thread exit, are incompatible kernel
Wasm changes. Kernels, hosts, packages, guest binaries, and VFS images from
ABI 41 must be rebuilt rather than mixed with ABI 42 artifacts.
#### Scalable fork continuations

ABI 42 replaces the fixed-capacity contiguous save buffer with dynamically
mapped linked chunks. Instrumented modules carry the strict version-1
`kandelo.wpk_fork.linked_frames` descriptor and import
`env.__wpk_fork_frame_reserve`, `env.__wpk_fork_frame_commit`, and
`env.__wpk_fork_frame_next`. The host validates the descriptor, owns chunk
allocation and cleanup, and rejects incomplete or stale instrumentation.

The transition is incompatible: generated postambles depend on
reserve-before-write and commit-after-write semantics, replay uses a validated
linked-node order, and instrumented modules require the seven-export control
set including `wpk_fork_abort_begin` and `wpk_fork_abort_end`. The old
channel-adjacent area is only an active-root handoff anchor. ABI 41 and older
programs must be rebuilt with the ABI 42 instrumenter, and package/VFS
artifacts must be rebuilt from source for the new ABI epoch.

Version 1 keeps inherited chunks at the parent's virtual addresses in the
child. Relocating and rebasing a serialized continuation is not part of this
ABI. The linked descriptor requires transactional-node and abort-unwinding
flags. A typed allocation failure before unwind returns its errno directly; a
later failure enters `ABORT_UNWINDING`, reconstructs the committed inner
frames, releases the partial continuation, and returns the errno from the
original `fork()` call without terminating the parent.

### ABI 43 activation-owned fork replay

ABI 43 batches two incompatible platform contracts: activation-owned fork
replay and capacity-bound kernel scratch transfers. The replay contract closes
the remaining dependency on mutable state in the parent Wasm instance. A fork
child receives copied linear memory but a newly instantiated module, globals,
tables, exception tags, and host Store. Module-static reference tables
therefore cannot prove that a replay value survived fork.

Every ABI 43 fork artifact carries the version-1
`kandelo.wpk_fork.capabilities` section with
`FORK_CAP_ACTIVATION_STATE_SAFE`. Instrumentation, package guards, Node and
browser executable resolution, worker launch, pthread launch, and side-module
loading treat the capability as part of the artifact contract. Missing,
duplicate, malformed, unknown-version, unknown-bit, or safety-bit-free
capabilities fail before execution.

ABI 43 also gives the process fork import an explicit transaction mode.
`kernel.kernel_fork` changes from `() -> i32` to `(i32) -> i32`, where mode 0
is ordinary fork and mode 1 is vfork. The process Worker maps those modes to
`SYS_FORK` and `SYS_VFORK`, carries the selected mode through capture, parent
replay, abort replay, child launch, and Worker initialization, and rejects a
different mode at the inherited call site. The centralized host passes the
same mode to the incompatible
`kernel_fork_process(parent_pid, caller_tid, mode)` export; Rust rejects any
unknown value with `EINVAL`. Artifact admission requires the exact import
signature, and the ABI snapshot owns both values.

For mode 1, the instrumented process Worker also places the exact aligned
private-prefix bytes in host-intercepted `SYS_VFORK` argument 0 and the
page-rounded reference/exception scratch high-water in argument 1. The host
admits at most 61,440 prefix bytes and 65,536 scratch bytes and returns
`EAGAIN` before the Rust child allocation when either bound is exceeded. This
is an ABI 43 semantic channel contract: it changes no syscall number, linked
frame encoding, kernel import/export signature, or structural snapshot field.
Ordinary `SYS_FORK` keeps all six arguments zero.

Mode 1 now selects the shared-memory vfork lifetime. A separate child Worker
retains the parent's existing `Shared WebAssembly.Memory`; it constructs no
child process Memory and copies no address-space bytes. The child receives a
private syscall channel, bounded replay workspace, Wasm instance, loader, and
continuation controller. The asynchronous import keeps only the calling parent
thread parked until successful exec commit or exact `_exit()`/signal/trap
teardown, while sibling pthreads remain runnable. Failed exec returns to the
child without ending the lifetime. Ambiguous forced termination contains the
whole shared address space rather than publishing an unsafe parent return.
Ordinary fork behavior is unchanged.

The exact-generation lifetime records and Node/browser Worker messages used to
coordinate launch and teardown are host-private protocol, not persisted guest
ABI. No new linked-frame field, marker getter, or public kernel export was
needed beyond the ABI 43 mode-aware import/export and bounded workspace
arguments described above. Release still requires the broader conformance,
upstream CRuby, and resident-memory proofs; those gates do not alter
the structural ABI decision.

The instrumenter also rejects any input that already carries fork control
exports, linked-frame imports, or fork metadata. This prevents a transformed
ABI 42 module from being run through the ABI 43 tool merely to acquire the new
safety claim; package builds must instrument raw linker output.

The frame contract remains version 1 and keeps its existing 16-byte header.
Offset `+8` carries the exact dynamic catch selector and the formerly
reference-stash-related word at `+12` carries a process reference-vector
ordinal. The instrumenter no longer creates
`_wpk_fork_funcref_stash`, `_wpk_fork_externref_stash`, or
`_wpk_fork_exnref_stash`.

Live reference locals, parameters, call operands/results, `call_ref` callees,
mutable reference globals, typed table entries, and complete exceptions use
one process-owned KFRV (Kandelo Fork Reference Vectors) recipe transaction
inside the KFMS (Kandelo Fork Module State) arena copied through linear memory.
Function/static-root catalogs reconstruct fresh instance-local identities;
typed GC recipes preserve concrete layout, cycles, aliases, and externalized
views. Materialization also re-registers weak constructor provenance for the
new object, including packed segment operands and nullable recipe-zero seeds,
so that the child can itself become the parent of a later fork. Durable
process-image handles represent opaque `externref` values.
Generated module-state helpers restore globals, table length/content, and
segment lifetime before frame replay. A generation-published sparse table
journal keeps pthread and late-dlopen replicas coherent without copying
WebAssembly functions or `exnref` values through JavaScript.

ABI 43's POSIX dynamic-loader path is staged and non-reentrant.
`__wasm_dlopen_prepare` validates and owns a private transaction without
entering Wasm. Each `__wasm_dlopen_next` advances host-only
compilation/instantiation as needed and returns one initializer table entry.
Instrumentation removes the native start section and exposes its initialization
as an explicit bootstrap stage, so instance construction cannot run that guest
path; libc invokes each returned entry only after the import returns.
Instrumentation lowers the historical canonical two-, four-, and five-argument
`__wasm_dlopen` imports to the same protocol before computing fork
reachability. The two-argument form retains its historical
`dlopen:<buffer-address>:<byte-length>` identity. The original imported
function identity becomes a local tail adapter, preserving table and `ref.func`
aliases without leaving a host callback under initialization.
Artifact publication and host launch reject an ABI 43 safety claim if the
legacy import or a native start section remains. Input modules may use a start
section, but an accepted completed transform must expose it only through
`wpk_fork_module_bootstrap`. The lower-level `DynamicLinker.dlopenSync()`
driver is an embedder API, not an accepted process import. The process Worker
must perform final instantiation and Store-local function/tag registration
even when kernel policy coordinates the load, because those identities cannot
be cloned from the kernel Worker.

ABI 43 also assigns channel-header offset 68 to `request_flags`.
`REQUEST_FLAG_DEFER_SIGNAL_DELIVERY` marks a request whose completion is
consumed by process-worker JavaScript rather than libc's ordinary post-syscall
signal trampoline. The kernel leaves a caught signal pending for such a
completion instead of dequeuing it into a channel record that JavaScript
cannot deliver. After `fork`, `clone`, or a staged-loader import returns, libc
issues a side-effect-free `getpid` checkpoint through the ordinary channel
path; that completion owns normal handler delivery and signal-mask restoration.
The flag occupies bit 2. Bits 0 and 1 independently record cancellation-point
membership and cancellation-wake authority, so all three meanings can be
preserved in one captured request snapshot. The flag changes neither the
continuation encoding nor any activation's frame size.

Statically tagged scalar `Catch`/`CatchRef` arms serialize their exact selector
and maximum live scalar tag tuple. During rewind the tool executes `throw` with
that reconstructed payload; the original clause creates a fresh
child-instance exnref. Reference/vector payloads, `CatchAll`, `CatchAllRef`,
JSTag ingress, and normalized legacy-EH cleanup paths use the
complete-exception recipe and likewise throw inside Wasm. Transaction cleanup
clears temporary tables, roots, and owner leases after replay or abort.

The capability therefore attests to present reconstruction machinery, not a
conservative source-shape rejection pass. Valid reference-bearing code outside
the fork closure remains unmodified; valid reference-bearing code inside the
closure receives the typed ownership path. Artifact validation still rejects
malformed/version-mismatched contracts and pre-instrumented ABI 42 input before
execution.

This is an incompatible artifact epoch even though the linked-frame descriptor
version is unchanged. All fork-instrumented programs, side modules, package
archives, binary indexes, shell closures, and VFS images must be rebuilt from
source. Existing C++ modern-EH outputs that retain exnref locals or use
`CatchAllRef`, and the Dash `expandstr` cleanup path, are supported rebuild
inputs through those recipes; they are not candidates for metadata relabeling
or package-specific bypasses. The ABI 43 development shell/rootfs closure can
be rebuilt from source. Broad package, index, shell, and image publication still
requires explicit release coordination. The exact archive-generation,
rootfs/image, and package sequencing and isolation boundary is recorded in
the [ABI 43 activation-state-safe artifact rebuild
plan](plans/2026-07-25-abi-43-activation-state-safe-rebuild-plan.md).

### ABI 43 capacity-bound kernel scratch transfers

PR #1097 merged as
`c7d039794a43788acfa0b0aea30a700c257f57cb` with ABI 42, and this work is
based on that exact merged result. ABI 43 is therefore required for the actual
incompatible export and wire changes below, including the added
`kernel_wait_child_poll` output-capacity argument. The version change is not
bookkeeping for generated constants. Exact final-head validation is a PR
readiness gate recorded with the commit SHA it actually exercised; this section
records the durable ABI contract rather than a mutable readiness claim.

ABI 43 makes variable-size host writes into reusable kernel scratch an
explicit ownership protocol. A host write is valid only after it
independently proves the caller source range, the kernel-owned destination
allocation, the allocation's declared capacity, the current kernel-memory
range, the allocation lifetime, exclusion of overlapping replacement, and
lossless wasm32/wasm64 pointer conversion. The fact that a destination range
fits somewhere in the kernel's total WebAssembly linear memory does not prove
that the Rust allocator assigned those bytes to the destination object.

Ordinary channel-sized transfers carry the kernel pointer and capacity
together in a host-side `KernelScratchRegion` and can be accessed only through
a synchronous lease. The `kernel_handle_channel` export now takes
`(channel_offset, channel_capacity, pid, retry_token)`; Rust rejects a capacity
other than the canonical complete channel allocation before decoding it. Token
zero starts an operation, while a positive token reactivates the exact
Rust-owned target retained for a represented retry. This signature change is
incompatible with an ABI-42 host or kernel.

ABI 43 also assigns the channel header's former four-byte reservation at offset
68 to generated `request_flags`. The cancellation-point and wake-authority
bits occupy bits 0 and 1. The deferred signal-delivery authority occupies bit
2. They are written before status publication, captured and cleared once by
the host, and retained with every asynchronous request snapshot. Unknown bits
and wake-without-cancellation-point fail closed. This is observable wire state,
not a host-only implementation detail.

`kernel_blocking_retry_token(pid, tid, syscall_nr)` returns the exact positive
token for a classified Rust target, zero for an authoritative host-only
snapshot, or a negated errno. `kernel_blocking_retry_release` consumes a
positive token. The trailing retry token on
`kernel_transfer_io_execute`, `kernel_transfer_channel_execute`,
`kernel_sendmsg`, and `kernel_recvmsg` prevents replay from resolving a numeric
fd, queue descriptor, or System V id that may have been closed and reused.
Completion and cancellation consume the token before the host deletes its
immutable snapshot.

Every generated pointer descriptor is explicitly and exclusively `required`
or `nullable`. Positive-extent null pointers fail unless the shared descriptor
permits null; an argument-sized null pointer with zero extent is canonicalized
to an allocator-owned empty range. The host pre-captures every caller-owned
`u32` used by a `Deref` size before planning any suballocation, then uses that
one value for both the dynamic buffer and its staged length record. Rust
validates the canonical ordered, aligned, non-overlapping descriptor layout
and the complete allocation range before dispatch. Because the generic wire
does not encode an unpadded capacity beside every descriptor, Rust cannot
independently detect a hypothetical staged-length change that stays within one
eight-byte alignment bucket; the exact capacity comes from the host's
pre-captured value under the single synchronous, non-reentrant lease. Adding a
second per-descriptor capacity would itself be a future ABI design change.

ABI 43 describes `getgroups` and `setgroups` through that generic pointer
table. Their count is a caller-native process-size scalar and their vector is
exactly `count * sizeof(gid_t)` bytes, bounded by `NGROUPS_MAX` before scratch
allocation. `getgroups` adds a generated return-value copy-out rule: the host
copies `return_value * sizeof(gid_t)` bytes, so a count-only query lends no
destination and a larger caller buffer keeps its unused tail. The public
`kernel_getgroups` export consequently takes only `(size, list)`; the former
host-selected capacity argument and special one-group handler are removed.

The same unpublished ABI 43 batch advances the exact fork and test-only exec
state record to version 15. After the parent identity it stores real,
effective, and saved UID; real, effective, and saved GID; an ordered bounded
supplementary-group vector; and the kernel-owned `secure_exec` bit. Versions
14 and 16, malformed counts, truncation, and trailing bytes are rejected
instead of reconstructed through a compatibility fallback. The complete
record is validated before the credential value or `secure_exec` is installed.

`prctl` deliberately has no generic pointer descriptor. Only `PR_SET_NAME` and
`PR_GET_NAME` interpret argument 1 as a required exact 16-byte scratch buffer;
other options preserve its low 32-bit scalar value. Treating that slot as one
shape for every option would either dereference a scalar or replace it with an
unrelated scratch pointer.

Large scalar and vector I/O uses a separate Rust-owned, single-use
reservation. `kernel_transfer_scratch_begin`,
`kernel_transfer_scratch_pointer`, and
`kernel_transfer_scratch_capacity` publish one initialized allocation only
while its positive token is `Reserved`. `kernel_transfer_io_execute` or
`kernel_transfer_channel_execute` consumes that token and enters
`Executing` before releasing the reservation mutex and calling any host
import. A normal return makes it `Ready`; `kernel_transfer_scratch_cancel`
then drops the allocation. The execute exports accept no host-selected
pointer, so allocation capacity cannot be separated from ownership.

ABI 43 also permits a narrower, read-only use while a transfer token remains
`Reserved`. `kernel_get_cwd`, `kernel_get_fd_path`, and
`kernel_get_dirfd_path` produce complete canonical path snapshots before an
asynchronous spawn, exec, or shared-mapping callback. A zero destination
capacity queries the exact byte length without dereferencing the pointer; a
positive short capacity returns `ERANGE` without writing. The host first tries
the ordinary region, reserves the exact required transfer capacity only when
needed, invokes the producer synchronously, detaches every byte, revokes the
region, and cancels the still-`Reserved` token. It does not call an execute
export for this case: the getter itself is the one Rust operation, and the
`Reserved` state already prevents another reservation from moving or replacing
the allocation.

Canonical CWD and descriptor paths are not limited to `PATH_MAX`. `PATH_MAX`
bounds one caller-supplied pathname; resolving that input against an
already-deep directory can create a longer internal absolute spelling.
Publishing a truncated prefix could select a different executable or mapping
backing. `kernel_get_dirfd_path` additionally requires the descriptor to name
a directory and returns `ENOTDIR` otherwise, while `kernel_get_fd_path`
retains the ordinary descriptor behavior required by `AT_EMPTY_PATH`.

A host-import trap can strand a reservation in `Executing`, where cancellation
must reject rather than free memory that a callback may still have partially
observed. The host therefore treats such a trap as a fatal kernel-generation
failure and admits no later ingress. This fail-closed lifetime rule, the
removed public raw scalar/vector exports, and the new required transactional
exports are incompatible ABI changes folded into the still-unreleased ABI 43;
they are not an additive ABI-42 extension.

Large `SYS_SPAWN` blobs use a Rust-owned reusable
`Vec<u8>` with a tokenized transaction:

1. `kernel_spawn_scratch_begin(minimum_capacity)` returns a fresh positive
   reservation token or a negated errno. Begin is nonblocking; mutex
   contention returns `EBUSY`.
2. `kernel_spawn_scratch_pointer(token)` and
   `kernel_spawn_scratch_capacity(token)` are read after begin; both return
   zero for a stale or non-current token or for mutex contention. The separate
   pointer-free
   `kernel_spawn_scratch_retained_capacity()` export reports the retained
   high-water allocation for diagnostics without granting write authority and
   likewise returns zero on contention.
3. The host proves the complete pointer-plus-capacity range and copies without
   yielding.
4. `kernel_spawn_reserved_process(parent_pid, caller_tid, token, blob_len)`
   consumes that exact token, parses into Rust-owned data, and releases the
   scratch lock before process-table work or host imports.
5. After every successful begin, the host calls
   `kernel_spawn_scratch_cancel(token)` in a `finally` block, including setup
   and copy failures. Success releases an unconsumed matching token; `EINVAL`
   means the never-reused token was already consumed or is stale. For the
   just-issued in-contract token after commit, the consumed case is expected.
   Commit and cancellation wait on the same no-host-import critical section,
   so both return with a definitive token state instead of stranding authority
   on transient contention.

Every large operation begins a new reservation even when the retained vector
already has enough capacity. Stale tokens, concurrent reservations, and
reentrant host operations cannot replace bytes being consumed. The previous
pointer-returning `kernel_spawn_scratch_reserve` interface and fixed
worst-case compatibility fallback are not part of ABI 43.

The same ABI 43 spawn transaction requires
`kernel_publish_spawn_child(parent_pid, child_pid)`. Rust marks a newly
reserved spawn child as unpublished, so wait selection cannot consume it while
the host performs asynchronous exact-target read, validation, compilation,
commit, and Worker launch. Publication verifies the exact parent/child pair,
clears that state once, and returns `-1` for a live child, zero for ordinary
exit, or the positive terminating signal. `-ESRCH` remains authoritative
child absence and is not a live sentinel; `-ECHILD` means the exact hidden
child remains owned but its bound parent is absent or has already exited, so
rollback must remove it.
The host publishes the successful spawn
result in the same serialized entry before waking queued waiters; failure uses
the existing exact removal path and also wakes them. That detached completion
does not depend on the parent mailbox registration remaining live, while every
parent-memory write still requires the exact active channel. No older export can own
that atomic boundary: target commit necessarily precedes a fallible Worker
launch, and process removal is the opposite, failure-only transition. This is
an additive structural change to the still-unpublished ABI 43 export set, so
the ABI snapshot and generated host manifest carry it without inventing ABI
44 or permitting a fallback.

ABI 43 requires `host_pread` and `host_pwrite` so positioned regular-file I/O
keeps a signed 64-bit offset lossless and does not mutate a shared
open-file-description cursor through seek emulation. It also requires the
paired append imports. `host_append(handle, pointer, length, limit_lo,
limit_hi)` performs one EOF/limit/write transaction, and
`host_append_position(handle, written)` consumes the matching one-shot ending
offset. Rust validates the returned prefix and ending position before
publishing its cursor. A backend that cannot provide this exact outcome must
return `EOPNOTSUPP` before mutation.

ABI 43 also makes System V IPC control-structure sizing explicit. Required
pointer-width queries report the target musl layouts: `msqid_ds` is 96 bytes
on wasm32 time64 and 120 bytes on wasm64 LP64, `semid_ds` is 72/88 bytes, and
`shmid_ds` is 88/112 bytes. The process width is authoritative even when it
differs from the kernel Wasm width. The host stages `msgctl`/`shmctl`
`IPC_STAT` and `IPC_SET` according to the command and carries that width in its
private sixth kernel-dispatch slot. The required
`kernel_semctl_array_bytes(pid, tid, semid, command)` export performs the
permission-aware GETALL/SETALL size preflight; the host does not substitute a
read-only `IPC_STAT` query for a write-only SETALL operation. (ABI 46 moves this marshalling into the kernel and
removes the sizing exports and the private sixth-slot width; see "ABI 46".)

Generated process-layout descriptors apply the same caller-width rule to
`stack_t` (12/24 bytes), the kernel-facing four-native-`long` `itimerval`
(16/32), `mq_attr` (32/64), `sigevent` (64/64), `statfs` (88/120), and
`sysinfo` (312/368), and `siginfo_t` for `rt_sigqueueinfo` (128/128). The host
stages exactly the selected record and carries the process width in its
private sixth dispatch slot. Rust rejects any other width and parses or
serializes the exact bounded slice; padding and reserved output bytes are
initialized. This prevents the kernel Wasm's own wasm32 data model from
truncating a wasm64 process record. Fixed generated descriptors separately
carry `stat` (112 bytes) and `sched_param` (48 bytes); those records do not use
width selection or the private process-width slot.

The channel `setsockopt` path uses the otherwise private sixth dispatch slot
for the same independently known caller width. The generated native
`group_req` layout is 132 bytes with its group at offset 4 on wasm32 and 136
bytes with its group at offset 8 on wasm64; `group_source_req` is 260/264
bytes with its source at offset 132/136. Rust accepts only widths 4 and 8.
Neither `optlen` nor padding bytes may select a data model. The public
five-argument `kernel_setsockopt` export is structurally unchanged and uses
the kernel's native width for direct calls; only channel dispatch consumes the
host-private width. Adding the generated layout constants and correcting this
interpretation remain part of unpublished ABI 43 and do not create ABI 44. (ABI 46 replaces the private sixth-slot width with
the process's registered pointer width.)

Signal and timer transport also change incompatibly in ABI 43. The
`kernel_timer_create` export grows from three arguments to
`(clock_id, sigevent_ptr, timerid_ptr, process_pointer_width)`, and its second
argument names the complete generated caller-native 64-byte `sigevent` instead
of a private four-`i32` prefix. The channel signal-delivery record grows from
44 to 56 bytes, while its reserved area grows from 48 to 56 bytes. Its
`si_value` slot is an unaligned eight-byte raw `union sigval`; wasm64 delivery
preserves all bits and wasm32 delivery uses the target-native low 32 bits.
`kernel_dequeue_signal` and `kernel_wait_child_poll` each gain an explicit
output-capacity argument so validation happens before either operation consumes
kernel state. POSIX message-queue notification now queues the authoritative
`SI_MESGQ` record in Rust, including the full raw value and sender credentials;
the eight-byte host record only tells the host which task to wake. These are
observable export and wire changes, not generation-only bookkeeping.

The ABI 43 required host-adapter export set retains the ABI 42-required
`kernel_spawn_process` and adds
`kernel_blocking_retry_release`,
`kernel_blocking_retry_token`,
`kernel_commit_process_exit`,
`kernel_get_cwd`, `kernel_get_dirfd_path`, `kernel_get_fd_path`,
`kernel_msqid_ds_bytes`, `kernel_semctl_array_bytes`,
`kernel_semid_ds_bytes`, `kernel_shmid_ds_bytes`,
`kernel_process_metadata_begin`, `kernel_process_metadata_cancel`,
`kernel_process_metadata_commit`, `kernel_process_metadata_stage`,
`kernel_set_cwd`,
`kernel_spawn_reserved_process`,
`kernel_spawn_scratch_begin`,
`kernel_spawn_scratch_cancel`, `kernel_spawn_scratch_capacity`,
`kernel_spawn_scratch_pointer`, and
`kernel_spawn_scratch_retained_capacity`, plus
`kernel_transfer_channel_execute`, `kernel_transfer_io_execute`, and the four
`kernel_transfer_scratch_*` exports described above. The required capabilities
and synchronization semantics changed, so this is incompatible rather than
bookkeeping around additive constants. Kernels, hosts, packages, guest
binaries, and VFS images from ABI 42 must be rebuilt rather than mixed with
ABI 43 artifacts.

`kernel_enum_procs` keeps its existing two-argument export signature, but its
producer contract is now atomic and capacity-derived. Rust computes the
complete snapshot with checked arithmetic using the packed 36-byte
per-process header defined by
`wasm_posix_shared::process_snapshot_wire`, returns `ENOSPC` before any write
when the supplied allocation is short, and constructs only the exact required
output slice on success. Generated TypeScript constants and the ABI snapshot
pin the same count/header sizes and every field offset; the host fails closed
on a malformed later record instead of returning a valid prefix. This corrects
the former 40-versus-36-byte accounting mismatch and removes cross-language
layout duplication without granting authority from the remainder of linear
memory or introducing another ABI epoch.

ABI 43 has not been published as a compatibility epoch. The retry-token,
large-transfer, fatal-lifetime, positioned-I/O, and append corrections amend
that same pending ABI-43 contract and snapshot. They do not justify inventing
ABI 44 merely to preserve an unreleased draft, and they must not be hidden
under released ABI 42.

The pending epoch also makes ordinary mount state authoritative for set-ID
execution. A retained executable's owner and `S_ISUID`/`S_ISGID` bits produce
the effective-credential transition on every mount that does not report
`ST_NOSUID`, including a writable VFS image. There is no private product
capability, immutable-image exception, or first-party executable allowlist in
that decision. The host retains and revalidates the executable handle, bytes,
metadata, mount flags, and inode identity before the kernel commits the
transition. Existing ABI-43 binaries must be rebuilt with this final
unpublished execution contract; preserving the earlier draft would not justify
creating ABI 44.

The same pending epoch also makes process-startup argv/environment reads
complete-or-`ERANGE`. A zero destination capacity queries the exact immutable
entry length; a positive short capacity writes nothing, and an exact-capacity
retry must return the same complete length. The signed C/Rust result still has
the same Wasm `i32` function type, but the error semantics and rebuilt CRT are
an observable contract change. The CRT validates the generated 4,096/4,096
entry caps and pointer-width-aware 4 MiB representation before allocating
guest-process memory through ordinary `mmap`; it never clamps a count or
copies a prefix into fixed 64/128 KiB buffers. This semantic correction belongs
in unpublished ABI 43 rather than being hidden under released ABI 42 or
creating an ABI 44 for an unreleased intermediate draft.

The four metadata-transaction exports and cwd setter are required because
process registration uses them unconditionally. Begin returns a positive
process-bound token; each stage synchronously copies one capacity-checked
scratch entry into Rust-owned storage; commit swaps the complete argv and
environment pair without a fallible allocation or host import; and cancel
drops an uncommitted token without changing live metadata. A failed stage
permanently makes its token uncommittable. Partial replacement is not part of
the contract: the host supplies both vectors or neither, so its generated
count and aggregate `ARG_MAX` validation never ignores bytes preserved from
an earlier pair. This prevents both an allocation overflow and the subtler
clear-then-push failure in which a later `ENOMEM` exposed a live prefix. The
complete CWD, fd-path, and directory-fd-path getters are required
because relative spawn/exec and shared-mapping resolution cannot safely fall
back to a fixed or truncating query. A same-version kernel may not use the
historical aggregate argv setter or clear/push metadata exports, silently
ignore initial cwd, or omit one of those path queries: each fallback would
accept boot while losing the bounded, capacity-owned transfer and atomic
replacement contracts that ABI 43 advertises.

The authoritative platform and spawn-wire constants remain generated from the
Rust ABI sources. Moving identical constants to that generation path would not
by itself require a bump; the required transactional exports and semantics do.
Making each `WasmPosixKernel` wrapper a one-generation, one-shot initializer is
host-side lifetime hardening for cached scratch allocations. It changes no
kernel export, wire layout, manifest capability, or accepted guest limit, so it
does not require an additional ABI epoch beyond 43.
The option-sensitive `prctl` operation values and the fixed scratch widths for
thread names, Fcntl lock records, and signal masks likewise have one shared
Rust authority and generated TypeScript consumers. Centralizing those
unchanged values is bookkeeping, not another ABI change.
The channel-handler signature, exhaustive pointer-nullability semantics, and
option-sensitive `prctl` marshalling are also incompatible contract changes
within ABI 43, not bookkeeping-only generation changes. Buffer sizing was
selected first for ownership and lifetime correctness. Retained-capacity,
peak-memory, and timing comparisons are not ABI facts: exact baseline and
candidate source identities, runtime-artifact fingerprints, workloads, and
separate Node.js/real-Chromium results belong in the draft PR evidence ledger
after the candidate is frozen. No latency improvement or broad performance
no-regression is claimed here.

### ABI 44 device identity and the Wayland stack

ABI 44 exists because `WasmStat` changed shape: it grows from 88 to 96
bytes with a trailing `st_rdev: u64` (offset 88, the slot libc's
`struct kstat` already reserved). Virtual device nodes report a
Linux-encoded `dev_t` -- `/dev/input/event{N}` is char major 13, minor
64+N -- because the real libinput path backend is handed only a node's
`st_rdev` (`udev_device_new_from_devnum`) and must recover the node from
it. Every artifact built against ABI 43 must be rebuilt; strict
`__abi_version` equality already refuses to mix them.

The rest of the Wayland stack's contract changes ride the same epoch. The
structural ones are recorded in the snapshot; the semantic ones change
what an existing call returns, which the snapshot cannot see, so they are
listed here:

- **`SO_PEERCRED`** (`struct ucred {pid, uid, gid}`), with Linux's
  capture points: an accepted AF_UNIX stream socket reports the process
  that called `connect()`, the connecting socket reports the listener as
  of `listen()`, a socketpair and a listener report their creator, and a
  socket with no AF_UNIX peer reports `{0, -1, -1}`. Before this epoch
  the kernel did not implement the option: `getsockopt(SO_PEERCRED)`
  failed with `ENOPROTOOPT`.
- **evdev ioctls**: `EVIOCGPHYS`/`EVIOCGUNIQ`/`EVIOCGPROP` join the
  caller-length `E`-magic families that libevdev issues while it
  constructs a device.
- **`DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE`**: an in/out ioctl that binds a
  bo imported from another process as a GL texture on the caller's GL
  session (GPU compositing).
- **Blocking `read()` of `/dev/dri/card0`** with no event queued now waits
  for one (the host parks it until the vblank tick delivers flip
  completions), as Linux's `drm_read` does. It used to return 0 -- end of
  file -- which libdrm's `drmHandleEvent` took as "no event", so a program
  that page-flipped and then waited flipped again into `EBUSY`.
- **`lseek()` on a prime-bo fd** behaves like a Linux dma-buf: only
  offset 0 with `SEEK_SET` or `SEEK_END`, and `SEEK_END` reports the
  buffer's size. It used to fail as an unsupported seek.
- **epoll registrations** are keyed on (fd, open file description), as on
  Linux: one survives `close(fd)` while a `dup` keeps its description
  open, ends once the last fd to it closes, and a new file reusing the fd
  number is a separate registration. Before, a registration was keyed on
  the fd number alone and outlived its file. Epoll instances now also cross
  `fork()` and `posix_spawn()` with their registrations (the child's
  inherited epoll fd used to name no instance), and the host's `epoll_wait`
  evaluates the kernel's registrations instead of keeping its own mirror;
  the new `kernel_epoll_watched_fd(pid, index)` export lists the fds a
  parked wait registers wakeups on. Fork state moves to `FORK_VERSION` 16
  to carry the instances (and each socket's peer credentials).
- **An epoll fd inside `poll()` or another epoll** reports `POLLIN` when
  one of its registrations is ready, as on Linux (nesting is followed four
  levels deep). It used to report never ready, so an event loop that
  watches an inner epoll fd -- libinput's inside libwayland's -- never woke.
- **A PRIME buffer fd passed over `SCM_RIGHTS`** holds its own reference
  to the buffer while in flight, as a Linux dma-buf fd does. The sender
  may close its copy as soon as `sendmsg()` returns; that used to drop the
  last reference and destroy the buffer before the receiver imported it.

Each semantic change corrects behavior toward Linux without changing a
layout. They share this epoch rather than taking their own because a
binary built against ABI 43 cannot run against an ABI 44 kernel at all;
no artifact can observe the old semantics under the new number.

### ABI 45 the DRI desktop stack

The Hyprland-class compositor, the toolkit ports behind foot, Waybar and
mako, the Omarchy desktop shell, Qt with Quickshell, and ScummVM change
the kernel's host-facing contract, so they take a new epoch. Every artifact built against ABI 44
must be rebuilt.

Structural changes (recorded in the snapshot):

- **`host_gl_present` returns a status.** The kernel import changed from
  `(i32) -> ()` to `(i32) -> (i32)`, so a GPU-tier present can report
  failure to the guest's `eglSwapBuffers`. A host built for ABI 44
  provides the old signature and cannot instantiate this kernel.
- **GPU-tier buffer objects.** `DRM_IOCTL_WPK_CREATE_GPU_BO` used to fail
  with `ENOSYS`; it now allocates a bo backed by a host WebGL2 texture and
  framebuffer through the new `host_gbm_gpu_bo_create` import, and joins
  the ioctl contract table. Without a shared GL context (headless Node, or
  before the compositor's context exists) the host returns `ENOSYS` and
  the guest falls back to a CPU dumb bo.
- **`GLIO_CREATE_SURFACE` attributes** grow from 12 to 20 bytes: a
  reserved field names the bo whose framebuffer the window surface
  renders into.
- **A new `host_kms_connector_mm` import** reports the display's physical
  size, which `DRM_IOCTL_MODE_GETCONNECTOR` now returns in
  `mm_width`/`mm_height` (they were always 0). A host built for ABI 44
  lacks the import and cannot instantiate this kernel. Host imports are not
  in the structural snapshot, which is why this is listed by hand.
- **`kernel_swap_poll_sigmask` / `kernel_restore_poll_sigmask`** exports
  let the host hold an epoll_pwait signal mask for the whole wait. The
  host still runs epoll_pwait itself (it converts the wait to poll
  retries), so without them the mask argument would be ignored and a
  signal the caller unblocks only inside the wait would never arrive.

Semantic changes (not visible to the snapshot):

- **epoll_pwait's signal mask covers the whole wait,** and a signal that
  the mask allows ends a parked wait so its handler runs. Before, a
  thread parked in epoll_pwait never saw a signal until the wait ended
  on its own (foot reaps children with SIGCHLD from exactly that wait).
- **SA_RESTART alone decides** whether a wait interrupted by a handler
  restarts; a handler without it now makes the call fail with `EINTR`.
- **sendmsg and recvmsg gather every iovec,** not only the first.
- **A new thread's initial stack pointer is 16-byte aligned,** which C++
  and varargs code require.
- **The GL command stream gains three ops and a query:**
  `OP_DETACH_SHADER`, `OP_VERTEX_ATTRIB_4FV`, `OP_DELETE_FRAMEBUFFERS` and
  `QOP_GET_SHADER_PRECISION_FORMAT` (`crates/shared` `gl` module,
  `libc/glue/gl_abi.h`). A guest GLES library that emits them needs a host
  that decodes them.
- **`/dev/input/event1` is an absolute pointer.** It no longer advertises
  `REL_X`/`REL_Y` (only the wheel axes stay relative), so consumers such as
  SDL's evdev backend read its `EV_ABS` positions, and its `EVIOCGABS`
  range follows the connector mode the display advertises. Before, the host
  faked absolute positions by pegging a relative cursor to the origin.
- **`inotify_init`, `inotify_add_watch` and `inotify_rm_watch` fail with
  `ENOSYS`.** They used to succeed with an fd that never delivered events,
  which kept Qt's and glib's file watchers from taking their polling
  fallback.
- **A `MAP_FIXED` mapping inside an existing mapping carves it,** leaving
  the rest of the old mapping in place, rather than evicting the whole
  mapping.

These share one epoch because a binary or host built for ABI 44 cannot
run against an ABI 45 kernel at all.

### ABI 46 fork metadata that survives wasm-opt

Fork instrumentation used to be the last step before a binary shipped.
From ABI 46 the instrumenter runs `wasm-opt -O2` over its own output,
which shrinks the code section of every measured program by 3–6% (see
"Optimization around instrumentation" in
[fork-instrumentation.md](fork-instrumentation.md)). wasm-opt is free to
delete imports nothing calls and to renumber the rest, so this epoch
removes the instrumenter metadata's dependence on import positions. Every
fork-instrumented artifact built against ABI 45 must be rebuilt.

Structural changes (recorded in the snapshot):

- **`kandelo.wpk_fork.imported_globals` and
  `kandelo.wpk_fork.imported_tables` move to format 2.** Each record's
  word at offset 20 used to hold the import's position in the import
  section. It is now reserved and must be zero. Hosts find the import by
  its kind, module name and field name instead. If several imports share
  that identity, the k-th record pairs with the k-th such import, and the
  counts must agree. A format 1 section fails validation.

Semantic changes (not visible to the snapshot):

- **Fork-runtime imports are optional when absent and exact when
  present.** Instrumentation is proven by the capability section, the
  `wpk_fork_*` control exports and the descriptors, which wasm-opt keeps.
  Imports are not: a module cannot use an import it does not declare, and
  wasm-opt removes the ones nothing calls. Two rules remain. The
  linked-frame core (`__wpk_fork_frame_reserve`, `commit`, `next`) is
  all-or-nothing, and a module with those frame imports must import the
  private unwind tag, because every instrumented frame catches it. A module
  with no fork-path frames of its own (it only re-exports `env.fork`, or
  wasm-opt removed every fork-path function) imports neither. Previously
  hosts, the shell guards and package publication required every
  `__wpk_fork_*` import, the resume table and the activation global, and
  required the frame core whenever fork was imported.
- **Instrumented modules declare every Wasm feature they use** in
  `target_features`. The instrumenter scans its output (operators, value
  and block types, memories, tables, tags) and adds what is missing. Its
  reference codecs use GC instructions such as `ref.test (ref i31)`,
  exception codecs return tuples (multivalue), and shared memories get
  atomic guards; wasm-opt enables only the features a module declares, so
  without the declaration it rejected every instrumented module.

Fork sinks (prototype; see
[plans/2026-10-02-fork-sinks.md](plans/2026-10-02-fork-sinks.md)) share
this epoch:

- **New optional import `env.__wpk_fork_boundary`, new export
  `wpk_fork_resume_sink(i32)`, and a new custom section
  `kandelo.wpk_fork.boundaries`** (`KFSB`, format 1: a count, then one
  record per boundary of a frame ordinal and a thunk-signature index).
  They are present only when the instrumenter found a boundary. A
  boundary is a function whose child, after fork, never returns to its
  caller.
- **Fork can complete below `_start`.** The parent's unwind stops at the
  deepest boundary on the stack. That function calls
  `__wpk_fork_boundary`, during which the host seals the capture, sends
  `SYS_FORK` and begins parent or abort replay. It then restarts its own
  callees in place. A child whose outermost replay frame is a boundary
  enters through `wpk_fork_resume_sink` instead of `_start`. That entry
  returns only if the sink itself returned, which the host reports as
  "fork child returned through its sink frame". A trap in the child's own
  code ends the process by its signal, like any other trap.
- **New custom section `kandelo.wpk_fork.dlopen_contract`** on a
  dlopen-capable main module analysed with compiler facts. Its text form
  is `v1`, a `mode` line (`traced-entries` or
  `assume-all-entries-fork-returning`), an `address-taken` line (`0` or
  `1`) and one `fork-returning <export>` line per exported function whose
  fork child can return to its caller. Under `traced-entries`, hosts
  refuse at `dlopen` a side module that imports a listed export (as an
  `env` function or a `GOT.func` slot), and every side module when
  `address-taken` is `1` (today's instrumenter never emits that
  combination; it switches such a module to
  `assume-all-entries-fork-returning`). A module without the section loads side modules
  as before; the instrumenter then never assumed anything about them.
  `kandelo.calltypes` and `kandelo.calltypes.code-sha256` are build inputs
  to the instrumenter, which removes them; they are not part of the ABI.
- **The crt no longer passes `main` as a pointer, and
  `__libc_start_main` calls its stage 2 directly**, so neither function
  is in the indirect function table. This is not an ABI surface by
  itself. The fork analysis relies on it.
- **A vfork child may `fork()` and `posix_spawn()`.** Both used to fail
  with `EAGAIN`. The fork copies the borrowed memory, and the grandchild
  adopts the vfork child's own continuation root (worker init field
  `forkLaunchRootFromCaller`). This is a host and kernel behavior change
  with no layout change. A binary built for an earlier ABI 46 host gets
  success where it got `EAGAIN`, which no correct program relied on. A
  nested `vfork()` and `pthread_create()` from a vfork child still fail
  with `EAGAIN`.

Additive changes within ABI 46 (no bump; see "Additive changes within an
ABI epoch" below):

- **`/dev/kandelo/clipboard`, the host clipboard device.** Five new
  kernel exports, listed as optional host-adapter exports, so a host
  checks for them and reports "unsupported" against a kernel without
  them: `kernel_clipboard_stage(ptr, len, offset)`,
  `kernel_clipboard_offer()` and `kernel_clipboard_ack(seq)` carry host
  text to the agent and its answer back, and
  `kernel_clipboard_guest_generation()` and
  `kernel_clipboard_guest_read(out_ptr, out_capacity, offset)` read back the
  desktop selection the agent reports (copy-out). A new
  `clipboard_device_abi` snapshot section records the guest-visible
  record header `{u32 version, u32 kind, u32 seq, u32 len}`, its two
  kinds (`KIND_OFFER_TEXT` = 1, host to agent; `KIND_GUEST_TEXT` = 2,
  agent to host), the acknowledgement `{u32 seq, i32 status}` and their
  constants, generated into `<kandelo/clipboard.h>` and
  `host/src/generated/abi.ts`. A `write()` to the device is either an
  8-byte acknowledgement or one whole `KIND_GUEST_TEXT` record. The new
  device path changes `open("/dev/kandelo/clipboard")` from `ENOENT` to
  success and adds `/dev/kandelo` to `ls /dev`; no binary built before it
  depended on either, and an agent built against it fails with `ENOENT`
  on an older ABI 46 kernel, which is the honest answer. Changing the
  record or acknowledgement layout later is incompatible and needs a
  bump; `dump-abi` accepts the section's first appearance as additive
  and classifies later changes inside it like any other section. No new
  kernel imports and no new wakeup types: the host learns the agent's
  answer by polling `kernel_clipboard_ack` on a timer, and a copy-out by
  polling `kernel_clipboard_guest_generation` while a copy gesture is
  pending.

### ABI 47 honest program links and kernel-owned host stdin

ABI 47 declares, in `shared::abi::HOST_ENV_IMPORTS`, every import the host
supplies to a user program from the `env` module (besides the fork runtime's,
which `WPK_FORK_REQUIRED_*` already declare). The snapshot records it as
`host_env_imports`, the host receives it as `HOST_ENV_IMPORTS` in
`host/src/generated/abi.ts`, and `dump-abi` writes the link-time allowance
`libc/glue/kandelo-host-imports.txt`, which replaces `--allow-undefined` in
every executable link. Before ABI 47 an executable could leave any symbol
undefined and the host stubbed unknown imports with a throwing function, so
configure checks accepted functions Kandelo lacks and programs trapped when
they first called one. An ABI 47 host refuses to instantiate a program that
imports anything undeclared from `env` (`host/src/env-imports.ts`), and
`scripts/check-program-env-imports.sh` surveys built programs for the same
rule. Both read the fork runtime's imports from the declarations too,
including `WPK_FORK_GLOBAL_IMPORTS`, the two immutable globals fork
instrumentation adds (the activation index and the table-generation fence).

ABI 47 also gives host-supplied stdin a kernel pipe
(`kernel_install_host_stdin_pipe`): fd 0 is an ordinary pipe read end shared
across `fork`, `dup`, and `exec`, instead of a host handle answered per pid.

The GL command stream gains `OP_BLEND_FUNC_SEPARATE`,
`OP_BLEND_EQUATION_SEPARATE` and the query `QOP_FINISH` (`crates/shared` `gl`
module, `libc/glue/gl_abi.h`, `host/src/webgl/ops.ts`), which back
`glBlendFuncSeparate`, `glBlendEquationSeparate`/`glBlendEquation` and
`glFinish`. Without them SDL2's GLES2 renderer, which looks up all of these at
startup, could not be created. A guest GLES library that emits them needs a
host that decodes them, so they ride this epoch rather than `OP_VERSION`.

Every artifact is rebuilt for ABI 47; the strict `__abi_version` equality
check rejects ABI 46 programs. As with any bump, the committed resolver bundle
`scripts/resolve-binary.bundle.mjs` embeds the ABI version and the required
kernel exports, so it is regenerated (`scripts/build-resolve-binary-bundle.sh`)
in the same change; a stale bundle rejects the new kernel "by artifact policy".

### ABI 48 opaque transport, kernel-owned marshalling, and kernel-owned readiness

ABI 48 takes the host out of the syscall data path. The guest marshals its
own pointer arguments, the kernel reads the arguments no static rule can
describe straight out of the caller's memory, and readiness, epoll interest
lists, and blocking-wait deadlines become kernel state. Every program must be
relinked against a rebuilt musl (the syscall glue changed), and every kernel
and host artifact is rebuilt with it; a binary or host built for ABI 47
cannot run against an ABI 48 kernel.

Structural changes (recorded in the snapshot):

- **Opaque channel records.** A new request flag,
  `REQUEST_FLAG_OPAQUE_RECORD` (bit 3 of `request_flags`), says the channel
  data buffer begins with a self-describing syscall record: record ABI v1 in
  `crates/shared/src/channel_record.rs` (magic, record ABI, syscall number,
  span count, the record's total byte length, the six scalar words, then span
  descriptors with direction and byte range). The host copies exactly
  `record_len` bytes into kernel scratch and back, and the kernel refuses a
  length outside `[64, 65480]` or a span ending past it; a record syscall
  never moves the rest of the 64 KiB data buffer. The guest glue emits one for every non-blocking syscall from
  the generated `bits/kandelo_syscall_marshal.h`; the kernel decodes it
  (`crates/runtime-core/src/channel_record_decode.rs`). Host-intercepted and
  host-retried blocking syscalls stay on the raw-argument path; the
  authoritative list is `crates/shared/src/host_raw_syscalls.rs`. The host
  hands a flagged request to the new export `kernel_handle_channel_record`
  (same channel layout as `kernel_handle_channel`, no retry token), and only
  that entry point decodes a record: `kernel_handle_channel` never inspects
  the data buffer for the record magic.
- **A fifth channel status, `TEARDOWN` = 4.** The host publishes it to unwind a
  guest thread parked in the channel wait without resuming an image that is
  being abandoned; the glue traps on observing it. A guest built for ABI 47
  would read it as an unknown status.
- **`SyscallArgSize::KernelDereferenced`.** A new argument size kind: the host
  copies nothing and the kernel reads and writes the caller's memory itself
  through `host_proc_read_bytes` / `host_proc_write_bytes`. It is declared
  for `writev`/`readv` (81/82), `sendmsg`/`recvmsg` (333/334),
  `preadv`/`pwritev`/`preadv2`/`pwritev2` (295–298), `msgsnd`/`msgrcv`/
  `msgctl` (339/338/340), `semctl` (343), `shmctl` (347), and
  `mq_timedsend`/`mq_timedreceive` (137/138). `epoll_ctl` (240) gains a
  descriptor for its nullable 16-byte input event.
- **The caller's pointer width is registered per process.** New export
  `kernel_set_process_pointer_width(pid, width)`; `Process` carries the width,
  a fork child inherits it, and the host registers it again for the image an
  exec installs. Channel argument slot 5 is no longer overwritten with the
  width on any path (three writers in the host, three in the guest glue), so
  slot 5 of `preadv2`/`pwritev2` is declared a `u32` scalar and carries the
  caller's `flags`. `PROCESS_POINTER_WIDTH_ARG_INDEX` leaves the generated
  TypeScript.
- **The fixed kernel-scratch message wires are retired.** `KernelIovecWire`,
  `KernelMsghdrWire`, `KernelCmsghdrWire`, and
  `kernel_message_wire.flattened_iovec_count` leave the snapshot, because
  nothing stages them any more.
- **Kernel exports: 332 → 198.** Removed: the five sizing exports the host no
  longer needs (`kernel_msqid_ds_bytes`, `kernel_semid_ds_bytes`,
  `kernel_shmid_ds_bytes`, `kernel_semctl_array_bytes`,
  `kernel_mq_descriptor_msgsize`); 24 exports nothing anywhere called
  (for example `kernel_get_fork_state`, `kernel_set_fork_exec`,
  `kernel_tgkill`, `kernel_is_signal_blocked`; the matching dead declarations
  in `libc/glue/syscall_imports.h` went too, and the matching arms of the
  legacy `libc/glue/syscall_glue.c`, which no build links, now return
  `ENOSYS`); and 116 dispatch-only handlers (`kernel_open`, `kernel_close`,
  `kernel_sendmsg`, `kernel_epoll_ctl`, …) that `kernel_handle_channel`
  reaches as plain Rust calls, so their export attribute published a symbol
  with no consumer.
  Added: `kernel_set_process_pointer_width`, `kernel_epoll_wake_indices`,
  `kernel_handle_channel_record` (also added to
  `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS`), and
  the wait-deadline family `kernel_set_wait_queue_enabled`,
  `kernel_wait_deadline_open`, `kernel_wait_deadline_remaining_ns`,
  `kernel_wait_deadline_close`, `kernel_wait_retire_process`,
  `kernel_next_wait_deadline_ns`, `kernel_wait_queue_len`, and
  `kernel_wait_queue_stats`. `kernel_shmid_ds_bytes` leaves
  `HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS`.
- **Network-readiness facts.** `io_multiplexing.net_readiness` defines the
  fact word a host backend reports (bytes buffered, end of stream, send ready,
  send closed, hang-up, sticky error, unobservable).
- **Network-interface ioctls join the ioctl contract.** `SIOCGIFNAME`,
  `SIOCGIFCONF`, `SIOCGIFADDR`, `SIOCGIFHWADDR`, and `SIOCGIFINDEX` are served
  by the kernel.

Host imports (not in the structural snapshot, so listed here): the kernel
imports 82 host functions, down from 85. Removed: `host_nanosleep`,
`host_sigsuspend_wait`, `host_futex_wait`, `host_call_signal_handler` (none
had a live caller, and the first three would have blocked the one kernel
thread every process shares), and `host_net_poll`. Added: `host_net_readiness`
(returns the fact word above instead of `poll` `revents`) and
`host_network_local_address`. `host_proc_read_bytes` and
`host_proc_write_bytes` change signature: the guest address is now a 64-bit
value, so a wasm64 pointer above 4 GiB is not truncated. A host built for
ABI 47 cannot instantiate this kernel.

The kernel fork/exec state record moves from `FORK_VERSION` 16 to 17: it
carries the registered pointer width, and it no longer serializes per-process
epoll registrations (see below).

Semantic changes (not visible to the snapshot):

- **A malformed or contradictory channel request fails only its own
  syscall.** The request header and record are written by the guest, so they
  are untrusted input. Each of these completes the one request with `EINVAL`
  and dispatches nothing: an unknown request-flag bit (as before),
  `REQUEST_FLAG_OPAQUE_RECORD` on a host-raw syscall (the host previously
  stopped the whole kernel worker, taking every process with it), the flag
  with no record in the data buffer (previously the raw arguments ran as if
  the flag were clear), a record that does not decode, and a record whose
  syscall number differs from the header's (previously the record's syscall
  ran). A raw request whose data buffer happens to begin with a record header
  (a `write` of such bytes, or record bytes left in the reused kernel scratch
  by an earlier request) is no longer decoded as a record; previously such
  bytes redirected that request, and later scalar-only requests from any
  process, to the syscall the bytes named.
- **epoll instances belong to the open file description.** `dup`, `fork`, and
  a non-CLOEXEC `exec` reach the same instance, so a fork child's `epoll_ctl`
  is visible to the parent. Interests are keyed on (registered descriptor
  number, open file description). `epoll_ctl` with a null event is `EFAULT`
  for `EPOLL_CTL_ADD`/`EPOLL_CTL_MOD`. The host keeps no copy of any
  interest list.
- **The kernel decides socket readiness.** Backends report facts and
  `runtime_core::net_readiness::stream_revents` maps them to `revents` for
  every backend on both hosts.
- **Blocking-wait deadlines are kernel state on `CLOCK_MONOTONIC`.** A
  wall-clock step no longer moves a pending `poll`, `select`, `epoll_wait`,
  `sigtimedwait`, or futex timeout. The host refuses to boot a kernel without
  `kernel_set_wait_queue_enabled` rather than fall back to wall-clock
  arithmetic.
- **`usleep` and an `epoll_wait` on an empty interest list no longer sleep the
  kernel thread.**
- **`preadv2`/`pwritev2` honour `flags`:** `RWF_NOWAIT` is implemented and
  every other `RWF_*` bit is refused with `EOPNOTSUPP`.
- **`sendmsg`/`recvmsg` read the caller's `msghdr`, iovec table and CMSG
  chain in the kernel,** in the caller's data model; `msg_controllen` above
  64 KiB is `EINVAL`; `recvmsg` publishes `msg_namelen`, `msg_controllen`,
  and `msg_flags` only for a delivered message; a blocked `sendmsg` retry
  keeps the descriptors it already captured.
- **SysV IPC and POSIX message queues are kernel-marshalled.** A blocked
  `msgsnd` keeps the payload it copied at entry and never re-reads the
  caller's buffer; `semctl` `GETALL`/`SETALL` size the array from the set
  itself under the requested command's permission check, with no `IPC_STAT`
  probe.

### ABI 49 the kernel owns the root filesystem

ABI 49 moves the machine's filesystem into the kernel. `/` is an in-kernel
filesystem the kernel builds by parsing the VFS image itself
(`crates/runtime-core/src/rootfs.rs`, reading the image through
`kandelo_image_fs.rs`), and the scratch mounts (`/tmp`, `/var/tmp`,
`/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv`, and `/dev/shm`) are
an in-kernel tmpfs (`tmpfs.rs`). The host stops being a filesystem: it serves
positioned reads of the image it holds, fetches the bytes of files the image
only names, and keeps a handle-only interface for host directories mounted
beneath `/`. The TypeScript filesystem (`MemoryFileSystem` and the vendored
SharedFS) is deleted. The guest syscall ABI and the libc glue are unchanged,
but `__abi_version` equality is exact, so every program, package archive and
VFS image is rebuilt for 49; a kernel or host built for ABI 48 cannot run
against the other.

Structural changes (recorded in the snapshot):

- **Kernel exports: 198 → 228.** Added, all optional for the host-adapter
  manifest (a host that boots without a `/` image calls none of the rootfs
  ones, and a process that holds no kernel-owned shared mapping none of the
  shared-mapping ones):
  - `kernel_rootfs_load_image(len_lo, len_hi)`: parse the boot image through
    `host_image_read` and install it as `/`. Refuses an image without the
    `KLZY` section (`EINVAL`) and an image whose metadata declares a
    different `kernelAbi` (`EPROTO`).
  - `kernel_set_rootfs_enabled`, `kernel_set_tmpfs_enabled`: hand `/` and
    the scratch prefixes to the in-kernel filesystems.
  - `kernel_set_rootfs_nosuid`: publish whether `/` was mounted `nosuid`.
  - `kernel_set_rootfs_now(sec_lo, sec_hi, nsec)`: the wall clock the base
    tree is stamped with.
  - `kernel_rootfs_set_foreign_prefixes(ptr, len)` and
    `kernel_rootfs_set_foreign_mount_roots(ptr, len)`: the host-mounted
    directories beneath `/` that the rootfs must not claim, and the
    directory handle that anchors each one.
  - `kernel_rootfs_read_file`, `kernel_rootfs_write_file`,
    `kernel_rootfs_stat_mode`, `kernel_rootfs_unlink_file`,
    `kernel_rootfs_mkdir_parents`: the host's own access to kernel-owned
    files (the main thread's `read_vfs_file`/`write_vfs_file`/
    `unlink_vfs_file`, the spawn preflight's program reads, and the browser's
    per-session TLS root certificate). A path under a scratch mount reaches
    tmpfs; any other path reaches the rootfs.
  - `kernel_rootfs_export_container_read(off_lo, off_hi, buf, len)`: stream
    the finished image of the live `/`, which replaces the host rebuilding
    one (`export_rootfs_image`).
  - `kernel_rootfs_load_manifest` and `kernel_rootfs_export_tree`: an
    alternative loader for a pre-walked tree and a metadata dump of the live
    tree, kept as entry points for tests and tools.
  - `kernel_set_image_build_determinism(seed_lo, seed_hi, epoch_lo,
    epoch_hi)`: boot a kernel whose realtime clock counts up from a fixed
    epoch and whose entropy is a seeded stream, for image builders only
    (`crates/runtime-core/src/image_build_determinism.rs`). The host refuses
    to boot a determinism-requesting builder on a kernel without it.
  - The kernel's shared-mapping table (`SharedMappingTable` in
    `crates/runtime-core/src/memory.rs`), which keeps SysV attachments and
    `MAP_SHARED` mappings of kernel-owned files coherent and replaces the
    host's TypeScript SysV mirror (`shmMappings` / `shmSegmentVersions`).
    The host calls them at the points it already published its own
    shared mappings:
    - `kernel_shared_mapping_process_count(pid)`: how many such mappings a
      process holds; the host caches "any" per pid for its syscall-boundary
      early-out.
    - `kernel_shared_mapping_sync_process(pid, force)`: publish and refresh
      at a syscall boundary (`force` at fork, the exec preflight and
      teardown).
    - `kernel_shared_mapping_release_process(pid, publish, detach)` and
      `kernel_shared_mapping_inherit(parent, child, child_memory_len)`:
      teardown/exec, and fork as one transaction covering the SysV
      attachment records too.
    - `kernel_shared_mapping_file_track(pid, addr, fd, len, file_offset,
      writable, memory_len)`: after `mmap` of a kernel-owned file; the
      kernel populates the range. `kernel_shared_mapping_flush`,
      `_unmap`, `_remap`, `_prepare_write` and `_protect` follow `msync`,
      `munmap`, `mremap` and `mprotect`. Process addresses and lengths are
      `u64`, so a wasm64 process can map above 4 GiB.
    - `kernel_shared_mapping_sysv_track`, `_sysv_sync_segment`,
      `_sysv_publish_mapping`, `_sysv_drop_mapping`: `shmat` and `shmdt`.
- **New errno values** `EDOM` (33), `EPROTO` (71), and `ENOEXEC` (8) join
  `wasm_posix_shared::Errno`, and `host/src/generated/abi.ts` gains a
  generated `ERRNO` table and `KANDELO_REFERENCE_EPOCH_SECONDS`.

Host imports (not in the structural snapshot, so listed here): the kernel
imports 76 host functions, down from 82.

- Removed, the path-taking filesystem family: `host_open`, `host_stat`,
  `host_lstat`, `host_statfs`, `host_pathconf`, `host_mkdir`, `host_rmdir`,
  `host_unlink`, `host_rename`, `host_link`, `host_symlink`, `host_readlink`,
  `host_chmod`, `host_chown`, `host_lchown`, `host_access`, `host_opendir`,
  `host_closedir`.
- Added, the handle-only family, each naming exactly one path component
  relative to a directory handle the host issued: `host_openat`,
  `host_fstatat`, `host_mkdirat`, `host_unlinkat`, `host_renameat`,
  `host_linkat`, `host_symlinkat`, `host_readlinkat`, `host_fchmodat`,
  `host_fchownat`. A directory is an ordinary handle (`host_openat` with
  `O_DIRECTORY`), iterated by `host_readdir` and released by `host_close`.
  The whole family is reached only under a host mount whose root handle the
  host published; a host with none (the browser) never sees a call.
- Changed: `host_utimensat` takes `(dir, name_ptr, name_len, atime_sec,
  atime_nsec, mtime_sec, mtime_nsec, flags)`.
- Added, the byte pipe for the kernel-owned `/`: `host_image_read(buf, len,
  off_lo, off_hi)`, a positioned read of the boot image, and
  `host_fetch_deferred(uri_ptr, uri_len, buf, len, off_lo, off_hi)`, a
  positioned read of a resource the image names by URI but does not carry
  (a URL-backed lazy file or a lazy archive). The kernel relays the image's
  URI unread; the host fetches it and answers `EAGAIN` while the fetch is in
  flight.

VFS image binding (not in the structural snapshot):

- An image must carry the kernel lazy-linkage section `KLZY` (container flag
  bit 4, `VFS_IMAGE_FLAG_HAS_KERNEL_LAZY`; layout in `crates/shared/src/lib.rs`)
  so the kernel can learn every lazy file's real size and archive membership
  without parsing the host-side JSON sections. Images written before ABI 49
  have none and are refused; rebuild them.
- The image metadata's `kernelAbi` is checked by the kernel at load
  (`image_policy::check_declared_abi`). The TypeScript binary resolver no
  longer opens VFS images to make that check.
- Images are written by the Rust writer (`crates/runtime-core/src/kandelo_image_write.rs`,
  reached from TypeScript builders through `crates/kandelo-image-module`).
  The filesystem body's superblock magic is `KIFS`, and `statfs(2)` on the
  image reports that `f_type`.

Semantic changes (not visible to the snapshot):

- **`/` and the scratch mounts are kernel state on both hosts.** Their
  metadata, permissions and contents live in the kernel's linear memory;
  only unmodified image content stays in the host's copy of the image.
  `fsync` on their files and directories succeeds without host work.
- **`_PC_PIPE_BUF` always has a value** (4096), including on the kernel's own
  filesystems and on captured stdio; the host pathconf table is gone and a
  host without `fpathconf(3)` defers to the kernel's.
- **`MAP_SHARED` mappings of a kernel-owned file** (anything under `/` or a
  scratch mount, including `/dev/shm`, and memfds) are kept coherent by the
  kernel: separate mappings, across `fork` and across independent opens,
  converge at syscall boundaries, read-only ones included; a publication is
  written into the file at once, so `read(2)` sees it; `write(2)`,
  `ftruncate(2)` and `O_TRUNC` show through existing mappings at the next
  boundary; writeback never grows a file past EOF; and the file stays alive
  for its mappings after its descriptors close or it is unlinked. A memfd
  `MAP_SHARED`, which ABI 48 populated once and never wrote back, is
  included. A writeback the file refuses is recorded at
  `/proc/kandelo/writeback_losses`, a new procfs file.
- **The SysV attachment mirror is kernel state.** Unchanged for a guest,
  including that a sole surviving attachment imports a departed peer's
  writes.
- **`/dev/shm` is tmpfs on both hosts**, not a host mount; the browser host no
  longer allocates a POSIX-shared-memory SharedArrayBuffer.
- **`mount(2)` is still `ENOSYS`.** The in-kernel filesystems are configured
  by the host at boot, not by the guest.

## The snapshot

`abi/snapshot.json` is generated by `cargo xtask dump-abi` from the
authoritative Rust sources and the freshly-built kernel `.wasm`. It
captures:

- `abi_version` — the integer [`ABI_VERSION`](../crates/shared/src/lib.rs).
- `platform_limits` — the advertised `ARG_MAX`, `PATH_MAX`, and `IOV_MAX`
  values plus defensive process-startup argv/environment count caps generated
  into the TypeScript host and public musl headers.
- `process_metadata_contract` — generated argv/environment kind selectors
  consumed by the replace-both token-bound host/kernel transaction.
- `process_snapshot_wire` — the packed process-table count prefix, 36-byte
  header, and every field offset shared by the Rust producer and TypeScript
  parser.
- `spawn_contract` — the complete non-forking spawn wire contract: syscall
  number, header and action layouts, opcodes, transported attribute bits,
  defensive count caps, public-limit aliases, and derived whole-blob ceiling.
  Any change to either this section or `platform_limits` is classified as
  breaking unless the ABI epoch changes.
- `channel_header` — field offsets and sizes in the channel header,
  read from `shared::channel::*` constants, including the generated
  request-flags word and known-bit mask.
- `channel_scalar_contract` — syscall arguments and results that must preserve
  signed or unsigned 64-bit values rather than taking the default 32-bit
  scalar path.
- `channel_signal_area` — signal-delivery slot offsets in the trailing
  bytes of the channel data buffer.
- `channel_buffers` — data buffer offset/size and minimum channel size.
- `channel_status_codes` — numeric values of `ChannelStatus` variants.
- `marshalled_structs` — per-struct layout (`size`, then `fields[]`
  with `name`, `offset`, `span`). `span` is bytes until the next field
  (or end of struct), so it includes alignment padding and catches any
  layout shift.
- `process_native_layouts` — the generated wasm32/wasm64 musl layouts used
  when the host reads native process records, including `iovec`, `msghdr`,
  `cmsghdr`, `siginfo_t`, `sigevent`, `group_req`, and
  `group_source_req`, plus the shared socket constants needed to interpret
  `SCM_RIGHTS`.
- `syscalls` — every syscall number named by the shared ABI metadata:
  the core `Syscall::from_u32` table plus `abi::extended_syscalls`
  entries for host-visible kernel/control syscalls that are not yet in
  the core enum.
- `syscall_arg_descriptors` — host marshalling descriptors for pointer
  arguments, including direction, size source, size multipliers/additions,
  fixed byte lengths, pointer nullability/requiredness, and any
  return-value-based copy-back adjustment. Generation tests require every
  pointer descriptor to select exactly one of nullable or required, compare
  the complete reviewed nullable set, and keep option-sensitive `prctl` out of
  this generic table.
- `pathconf_names` — the shared numeric `_PC_*` vocabulary consumed by the
  kernel, generated host bindings, and libc wrappers.
- `host_adapter` — Rust-owned boot manifest metadata consumed by host
  adapters: manifest layout, host adapter protocol version, required
  worker feature bits, and required/optional kernel exports.
- `process_memory_layout` — Rust-owned process memory layout metadata:
  Wasm page size, default process memory settings, main control pages,
  pthread slot page offsets, and the process-wasm thread-slot declaration
  contract.
- `custom_sections` — names of wasm custom sections that participate in
  the ABI: `wasm-posix-abi` for the per-binary version and
  `kandelo.wpk_fork.linked_frames` for the linked-continuation layout, and
  `kandelo.wpk_fork.capabilities` for fork role and activation-safety claims.
- `process_expected_globals` — globals every user process instance is
  expected to expose for the host to thread through fork/exec.
- `program_artifact` — requirements checked on instrumented user programs
  before they can be published: the linked-frame descriptor schema, its
  wasm32/wasm64 header sizes, the three transactional frame imports, and
  the seven `wpk_fork_*` control exports with pointer-width-aware signatures,
  plus the capability-section version, known bits, and required safety bit.
  The descriptor width, function signatures, capability claims, and the
  module's single memory address width are validated as one contract.
  WHY this is snapshot-owned: a program can otherwise pass kernel ABI checks
  yet fail only when its first `fork()` reaches a newer host.
- `kernel_exports` — every non-toolchain export in the built kernel
  `.wasm`: function signatures (`(params) -> (results)`), global
  types/mutability, memory + table entries. Toolchain-internal
  symbols (`__wasm_call_ctors`, `__data_end`, `__llvm_*`, etc.) are
  filtered out by `shared::abi::export_is_tracked`. For immutable
  globals whose name matches `ABI_VALUE_CAPTURE_PREFIXES` (today
  `__abi_*`), the initial value is captured as well — so a change to
  an ABI-flag constant moves the snapshot directly.
- `export_deny` — the filter lists themselves (`deny_prefixes`,
  `deny_exact`, `value_capture_prefixes`). Making the filter part of
  the snapshot means adding or removing a pattern is itself an
  ABI-relevant change, tracked by the normal diff.

Fields are sorted alphabetically at every level, and the generator
writes the same bytes for the same input — the snapshot is a pure
function of the checked-in source.

The same generator also owns the cross-language consumers of these snapshotted
constants. Advertised `ARG_MAX`, `PATH_MAX`, and `IOV_MAX`, plus the
process-startup argv/environment count caps, live in
`crates/shared/src/lib.rs::platform_limits`; `cargo xtask dump-abi` writes
their TypeScript consumer and the public musl
`bits/kandelo_limits.h`. The non-forking spawn wire contract lives separately
in `crates/shared/src/lib.rs::spawn_contract`; the generator writes its C
consumer to
`libc/musl-overlay/src/process/wasm32posix/spawn_contract.h`. The private spawn
header aliases the public generated limits—including the startup count
caps—and adds the four-byte string-offset
width; all field offsets in the 40-byte header and 28-byte action record; the
five action opcodes; musl's complete transported attribute byte; the
spawn-only action count cap; and the derived 8,417,320-byte whole-blob
ceiling. Rust, TypeScript, and C therefore consume the same numeric wire
contract. Transporting all eight attribute bits is distinct from implementing
them: the kernel currently acts on `RESETIDS`, `SETPGROUP`, `SETSIGDEF`,
`SETSIGMASK`, and `SETSID`, while `SETSCHEDPARAM`, `SETSCHEDULER`, and
`USEVFORK` remain uninterpreted. The shared startup counts and spawn-only
action/complete wire caps are defensive representation limits, not new POSIX
promises.

Channel scalar widths are likewise Rust-owned. The generator writes
`host/src/generated/abi.ts` and
`libc/musl-overlay/include/bits/kandelo_channel_scalars.h` from
`crates/shared/src/channel_scalar.rs`; the ABI snapshot records the same
contract. Generated freshness tests fail if TypeScript, C, and Rust disagree
about a signed/unsigned 64-bit argument or result.

Native process layouts and fixed kernel wires follow the same ownership rule.
`crates/shared/src/process_layout.rs` owns the wasm32/wasm64 native
`iovec`/`msghdr`/`cmsghdr`, `pollfd`, and `fd_set` values; the generator writes
TypeScript plus `bits/kandelo_process_layouts.h`, and the dual-width C layout
test checks the installed musl sysroots. The fixed `KernelIovecWire`,
`KernelMsghdrWire`, and `KernelCmsghdrWire` structures remain snapshotted
`repr(C)` ABI records. The same generated/snapshotted contract carries the
one-record flattened kernel-iovec count and socket-message constants consumed
by the host, including `MSG_TRUNC`; Rust refuses a different flattened count
until its parser is changed in lockstep. Generating identical native constants
is bookkeeping and does not itself require a bump; changing an existing fixed
wire or observable accepted layout is evaluated under the normal
incompatible-change rules.

## Developer workflow

On a change:

```bash
# 1. Make your change to kernel / shared / glue as needed.
# 2. Regenerate the snapshot. This rebuilds the kernel wasm first so
#    a stale binary can't defeat the check.
scripts/dev-shell.sh bash scripts/check-abi-version.sh update
# 3. Inspect the diff. If it's empty, the change didn't touch the ABI.
#    If it is only an additive-compatible change, commit the snapshot
#    without bumping ABI_VERSION. If it changes existing ABI surface,
#    bump ABI_VERSION in crates/shared/src/lib.rs in the same commit.
# 4. Verify.
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

In CI:

```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

Fails if the committed snapshot drifts from the source. If the snapshot
changed versus `origin/main` without a matching `ABI_VERSION` bump, CI
classifies the diff and accepts only the additive cases listed above.

## What the check does **not** catch

- **Semantic changes with the same signature.** Reinterpreting a
  syscall argument, changing blocking behavior, or changing an errno
  value will not show up in the snapshot. Reviewers must catch these.
- **Things not in the generator's coverage list.** Whatever
  `xtask dump-abi` doesn't inspect isn't tracked. Treat the coverage
  list as itself ABI-critical: adding or removing an entry from
  `tools/xtask/src/dump_abi.rs` is an ABI-relevant change. (The export
  filter lists in `shared::abi::EXPORT_DENY_*` are themselves in the
  snapshot, so at least those are self-tracking.)
- **Host-side assumptions not reflected in Rust-owned ABI metadata.**
  Process memory layout constants should live in `wasm-posix-shared`,
  flow through generated TypeScript, and appear in
  `process_memory_layout`. Host-only constants outside that path are not
  protected by the ABI check.

## ABI bumps and package rebuilds

Every built binary carries the ABI version it was compiled against in a
wasm custom section (`wasm-posix-abi`). The host refuses to launch a
binary whose custom-section version does not match the kernel's
`__abi_version` export.

`ABI_VERSION` is one of the inputs to every package's cache key. When the
ABI is bumped, every package's cache key changes, so the next resolve
misses the local cache and rebuilds the package from source under the new
key. There is no remote binary release to cut or index to publish: the
local content-addressed cache and the source-build path handle the
transition automatically. Artifacts built under the old ABI remain in the
cache under their old keys and stay valid for old kernel revisions.

### Additive changes within an ABI epoch

Pure additions do not bump `ABI_VERSION`. Existing binaries still carry
the same ABI number, and the host-side `verifyProgramAbi` check remains
strict equality (`actual !== expected`). This is intentional: we keep a
single breaking-compatibility epoch rather than accepting arbitrary
older binaries against newer kernels.

The package cache key remains keyed by `ABI_VERSION`,
so additive kernel API growth does not force every package to rebuild.
Packages built after an additive change may depend on the new syscall or
export; those packages should be resolved with the matching current
kernel, even though the ABI epoch did not change.

An additive export is compatible only while existing required capabilities and
existing semantics remain unchanged. ABI 43's scratch work is deliberately not
such an addition: it expands the required host-adapter export set, removes the
older large-spawn reservation/fallback contract, and changes the synchronization
semantics of reusable storage. By contrast, identical generated spawn/native
layout constants and an internal TypeScript pointer-plus-capacity value would
not by themselves require an ABI version bump.
