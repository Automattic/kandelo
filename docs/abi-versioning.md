# ABI versioning

User programs and prebuilt binaries are compiled against the kernel's binary
interface. When the kernel changes that interface in a way that breaks old
binaries, running an old binary against a new kernel would silently corrupt
state. To prevent this, the project maintains:

1. A single integer [`ABI_VERSION`](../crates/shared/src/lib.rs) that every
   compiled binary carries and the kernel exports.
2. A structural snapshot of the ABI surface at
   [`abi/snapshot.json`](../abi/snapshot.json), regenerated from source.
3. A CI check that refuses to let the snapshot drift from source, and
   refuses no-bump snapshot changes unless they are narrowly additive.

**Agents and humans alike: do not change the kernel ABI incompatibly
without bumping `ABI_VERSION`.** The check is structural, not a
convention — CI enforces it.

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
  decide whether a main/side-module pair can safely coordinate fork replay.
- Renaming the ABI custom section or the process-expected globals.
- Changing the meaning of a syscall argument, errno, or blocking
  behavior without changing its signature. **This is not caught
  structurally — reviewers must flag it and bump anyway.**

The fork-capability section has an explicit ABI transition rule. ABI 16 accepts
an absent section through the pre-existing five-export fallback, while treating
a present marker as authoritative. ABI 17 was intentionally skipped; ABI 18
was the first epoch above 16 and made the role marker mandatory.

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

These additions still require regenerating and committing
`abi/snapshot.json`. They do not permit older kernels to run newer
programs that require the new surface; they only permit older programs
to keep running on newer kernels in the same `ABI_VERSION` epoch.

### ABI 41 fork-continuation reserve

ABI 41 increases each fork-continuation save buffer from 16 KiB to 60 KiB.
The reserve occupies the upper part of an existing 64 KiB scratch page and
leaves a 4 KiB prefix for host-owned control metadata. It covers the measured
49,232-byte Homebrew Bash continuation with 12,208 bytes of headroom while
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
`_exit` intentionally traps instead of returning through the dispatcher, it
clears the binding before trapping. Missing, rejected, stale, or exited task
bindings fail closed with `ESRCH`; no PID-only ambient selector remains.

All host-initiated guest mutations that previously depended on such a selector
now carry their authority explicitly. `kernel_dequeue_signal(pid, tid,
out_ptr)`, `kernel_wait_child_poll(parent_pid, caller_tid, target_pid,
event_mask, flags, out_ptr)`, and `kernel_prepare_write_operation(pid, tid,
fd, offset, len, positioned)` validate the exact live caller before consuming
signal or wait state or applying write-limit side effects. Guest SysV shared
memory calls use `kernel_ipc_shmat_for_task(pid, tid, ...)` and
`kernel_ipc_shmdt_for_task(pid, tid, ...)`; lifecycle-only inheritance,
rollback, and teardown use the separate explicit-process
`kernel_ipc_shmat_for_process` and `kernel_ipc_shmdt_for_process` exports.
The former `kernel_set_current_pid` export is removed.

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
programs must be rebuilt with the ABI 42 instrumenter and package/VFS artifacts
must be republished for the new ABI epoch.

Version 1 keeps inherited chunks at the parent's virtual addresses in the
child. Relocating and rebasing a serialized continuation is not part of this
ABI. The linked descriptor requires transactional-node and abort-unwinding
flags. A typed allocation failure before unwind returns its errno directly; a
later failure enters `ABORT_UNWINDING`, reconstructs the committed inner
frames, releases the partial continuation, and returns the errno from the
original `fork()` call without terminating the parent.

## The snapshot

`abi/snapshot.json` is generated by `cargo xtask dump-abi` from the
authoritative Rust sources and the freshly-built kernel `.wasm`. It
captures:

- `abi_version` — the integer [`ABI_VERSION`](../crates/shared/src/lib.rs).
- `channel_header` — field offsets and sizes in the channel header,
  read from `shared::channel::*` constants.
- `channel_signal_area` — signal-delivery slot offsets in the trailing
  bytes of the channel data buffer.
- `channel_buffers` — data buffer offset/size and minimum channel size.
- `channel_status_codes` — numeric values of `ChannelStatus` variants.
- `marshalled_structs` — per-struct layout (`size`, then `fields[]`
  with `name`, `offset`, `span`). `span` is bytes until the next field
  (or end of struct), so it includes alignment padding and catches any
  layout shift.
- `syscalls` — every syscall number named by the shared ABI metadata:
  the core `Syscall::from_u32` table plus `abi::extended_syscalls`
  entries for host-visible kernel/control syscalls that are not yet in
  the core enum.
- `syscall_arg_descriptors` — host marshalling descriptors for pointer
  arguments, including direction, size source, size multipliers/additions,
  fixed byte lengths, pointer nullability/requiredness, and any
  return-value-based copy-back adjustment.
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
  `kandelo.wpk_fork.linked_frames` for the linked-continuation layout.
- `process_expected_globals` — globals every user process instance is
  expected to expose for the host to thread through fork/exec.
- `program_artifact` — requirements checked on instrumented user programs
  before they can be published: the linked-frame descriptor schema, its
  wasm32/wasm64 header sizes, the three transactional frame imports, and
  the seven `wpk_fork_*` control exports with pointer-width-aware signatures.
  The descriptor width, function signatures, and the module's single memory
  address width are validated as one contract.
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

## Developer workflow

On a change:

```bash
# 1. Make your change to kernel / shared / glue as needed.
# 2. Regenerate the snapshot. This rebuilds the kernel wasm first so
#    a stale binary can't defeat the check.
bash scripts/check-abi-version.sh update
# 3. Inspect the diff. If it's empty, the change didn't touch the ABI.
#    If it is only an additive-compatible change, commit the snapshot
#    without bumping ABI_VERSION. If it changes existing ABI surface,
#    bump ABI_VERSION in crates/shared/src/lib.rs in the same commit.
# 4. Verify.
bash scripts/check-abi-version.sh
```

In CI:

```bash
bash scripts/check-abi-version.sh
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

## Rollout of prebuilt binaries

Binaries published to hosting (GitHub Releases) carry the ABI version
they were built against in their filename directory (`abi-v1/`) and in
a wasm custom section (`wasm-posix-abi`). The host refuses to launch a
binary whose custom-section version does not match the kernel's
`__abi_version` export.

When the ABI is bumped, all binaries must be rebuilt and a new
`binaries-abi-v{N}` release is cut. Old releases remain valid for old
kernel revisions; the new release's `index.toml` ledger lists all
v(N) archives. Each `packages/registry/<pkg>/build.toml`'s `[binary]
index_url` templates `{abi}` against the current `ABI_VERSION`, so
the next fetch automatically hits the v(N+1) release after the
constant bumps — no per-package URL pinning in-tree to amend. The
matrix flow's per-entry `scripts/index-update.sh` invocations
populate the new tag's `index.toml` atomically as each archive
publishes.

### Additive changes within an ABI epoch

Pure additions do not bump `ABI_VERSION`. Existing binaries still carry
the same ABI number, and the host-side `verifyProgramAbi` check remains
strict equality (`actual !== expected`). This is intentional: we keep a
single breaking-compatibility epoch rather than accepting arbitrary
older binaries against newer kernels.

The package cache key and release index remain keyed by `ABI_VERSION`,
so additive kernel API growth does not force every package to rebuild.
Packages built after an additive change may depend on the new syscall or
export; those packages should be resolved with the matching current
kernel, even though the ABI epoch did not change.
