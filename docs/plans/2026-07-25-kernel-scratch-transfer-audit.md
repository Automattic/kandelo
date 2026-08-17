# Kernel Scratch Transfer Audit

Status: this audit began on exact PR #1094 head
`6d923c6454dd7174082f25c3d3991d03f86f5ddb`; that historical evidence is
preserved below. PR #1094 closed without merging. Its main-first replacement,
PR #1097, merged as
`c7d039794a43788acfa0b0aea30a700c257f57cb`, and this branch has been
retargeted to that merge result. PR #1097 shipped ABI 42; the incompatible
export changes documented here intentionally use the still-unpublished ABI
43. No ABI 44 is introduced. Because recording a commit's own SHA in a tracked
document would change that SHA, the mutable exact-PR-head validation ledger
belongs in the draft PR description after the head is frozen. This audit
records source evidence, reproductions, and validation targets; it does not
claim a browser run, performance measurement, or full build for the current
head. Brandon's approval must be requested only when the external ledger names
that head and its exact results.

## Scope and method

This audit covers every host write or copy into the kernel WebAssembly
`Memory` and every scratch readback, especially pointers returned by
`kernel_alloc_scratch`. It records process-memory, framebuffer, and
shared-memory copies too, but keeps them out of the kernel-scratch abstraction
when a different owner and lifetime apply.

The inventory was built from all occurrences of:

- `kernelMem.set`, `Uint8Array.set`/`fill`, `DataView` writes, and equivalent
  typed views over kernel memory;
- `scratchOffset`, `tcpScratchOffset`, `largeSpawnScratchOffset`, and
  `kernel_alloc_scratch`;
- Rust exports that receive a host-selected kernel pointer;
- host imports through which Rust lends a pointer and capacity to TypeScript;
- promises, worker messages, callbacks, and retry state that might outlive a
  scratch use.

The unsafe PTY, cwd, vector-I/O, and message-I/O paths were also present in
base `df8fd9`, an ancestor of the audited #1094 head. They are pre-existing
defects and are not attributed to #1094.

The tables distinguish three source-safety dispositions:

- **Confirmed unsafe** means the old source admits the transfer and the focused
  reproduction demonstrates the missing ownership, capacity, range, or
  conversion proof.
- **Safe in current source** means the current source contains the stated proof
  and focused coverage exists.
- **Uncertain** means source inspection has not yet been paired with executable
  evidence sufficient for a safe disposition. Uncertainty is not treated as
  safety.

Validation status is tracked independently from source safety. Legacy table
cells that say **Implemented; validation pending** or **final-head rerun
pending** mean **Safe in current source** for the source disposition; they do
not make an exact-head validation claim. Test names below identify executable
coverage targets, not results from this documentation-only finalization. The
draft PR's exact-head ledger supersedes those labels only when it names the
current commit and exact commands.

## Required invariant

A host transfer into kernel Wasm memory is accepted only after proving these
facts independently:

1. The source range belongs to the caller.
2. The destination is a kernel-owned allocation.
3. The requested bytes fit the allocation's declared capacity.
4. The destination range fits the current kernel `Memory.buffer`.
5. The allocation remains live through the complete use.
6. Reentrant or concurrent work cannot observe partially replaced bytes.
7. wasm32/wasm64 pointer conversion is checked and lossless.

The third and fourth checks are deliberately separate. A pointer may be well
inside the current linear memory while the range following it crosses from a
65 KiB allocation into an adjacent Rust heap object.

## Ownership abstraction

`host/src/kernel-scratch.ts` owns the common contract:

- `KernelScratchRegion`, `KernelScratchLease`, and `KernelScratchDataView` are
  exported structural interfaces only. Their concrete classes are
  module-private, so JavaScript or a TypeScript `any` cast cannot invoke an
  erased `private` constructor. The implementation privately carries
  `memory`, `pointer`, pointer width, capacity, and a diagnostic label.
  Production regions come only from `allocateKernelScratchRegion` or
  `reserveKernelScratchRegion`; the compiler-backed contract inventories
  every direct or aliased factory call and admits only the six exact
  kernel-export-backed production sites: four persistent allocations plus the
  spawn and generic-transfer token reservations.
  Reservation-derived regions are single-use and explicitly revoked when
  their Rust token is consumed or cancelled, so a later `Vec` growth cannot
  revive a stale pointer/capacity pair.
- `KernelScratchLease` is the only read/write interface. Every operation
  rechecks non-negative safe-integer offsets and lengths, allocation capacity,
  pointer arithmetic, pointer width, and the current memory buffer. Bulk
  sources are normalized through intrinsic typed-array slots before the native
  `set`; subclass getters and `subarray` overrides cannot lie about their span.
  Constructors, slot getters, `set`, `fill`, every exposed `DataView` method,
  and `Reflect.apply` are captured when the module loads. Bulk write receivers
  span exactly the checked owned range rather than the full linear memory.
  Replacing live prototypes therefore cannot widen a write, intercept it, or
  turn a detached result into a view of reusable kernel memory.
- `withLease` permits sequential reuse but rejects nested/reentrant use and
  promise escape. It invalidates the lease before inspecting the returned
  value for a promise/thenable, so even a hostile `then` getter cannot extend
  the callback lifetime. A guarded `KernelScratchDataView` checks the active
  lease on every scalar access, keeps its native `DataView` private, and
  reuses it only while `Memory.buffer` has the same identity. After an
  in-lease `memory.grow()`, it repeats the complete owned-range proof before
  caching a replacement view.
- `checkedMemoryRange` handles Rust-lent destinations and caller-owned process
  ranges without pretending that they are allocator-owned scratch. Address
  zero is allowed only when the specific caller-memory contract permits it.
  `checkedWasmImportMemoryRange` separately normalizes raw signed wasm32 import
  values (or wasm64 `bigint` values) before applying the same lossless
  pointer, length, overflow, null, and current-memory checks.
  `checkedKernelExportPointer` performs the analogous signed-bit normalization
  only for raw allocator/reservation export results; caller-supplied negative
  pointers remain invalid.

The public wrapper no longer exposes mutable kernel `Memory`, a raw
`WebAssembly.Instance`, its export namespace, the import object, scratch
regions, or region factories. Generation-bearing fields and helpers on
`WasmPosixKernel` and the worker-owned kernel and scratch regions are
ECMAScript `#private`; reflection cannot recover them by spelling a former
TypeScript-private property name. An internal module capability grants the
dedicated worker the exact gated facade and Memory it owns. Separate focused
test proxies require module-secret capabilities. Neither path is re-exported
from a supported host API entry point. This is an intentional
public-host-API incompatibility: callers that previously depended on
`getMemory()` or instance inspection must use an ownership-specific API rather
than recovering a bare allocation address.

`host/test/support/wasm-memory-write-audit.ts` and
`host/test/kernel-scratch-contract.test.ts` form the static contract. The
TypeScript compiler and type checker discover production JavaScript,
TypeScript, and selected diagnostic sources recursively, seed their ownership
roots, and propagate kernel-memory ownership through aliases, helper parameters
and returns, spreads, destructuring, logical/comma expressions, loop bindings,
and common intrinsic array element/callback methods. The audit conservatively
follows a `getInstance().exports.memory` or `getMemory()` spelling as potential
kernel authority even though the supported public facade now exposes neither
mutable value; this makes their reintroduction fail closed. Typed-array
receiver methods use a positive non-retaining whitelist; callback container
arguments and retained iterators remain visible to the analysis. They report raw
typed/DataView construction, scalar and bulk writes, escapes, persistent
stores, returned views, allocator calls, scratch-region factory calls, and
spawn/generic-transfer scratch-reservation calls. The complete generated
kernel-export set from `abi/snapshot.json` is the default-deny raw-call
universe. `KERNEL_SCRATCH_EXPORT_NAMES` is the narrower, manually reviewed
capability list that a lease may invoke, and the audit fails if that list
contains a name absent from the generated set. A newly generated export is
therefore still classified and denied when it is omitted from the runtime
scratch list; the omission cannot hide a raw call. Direct members,
computed/unknown export access, destructuring, aliases,
`call`/`apply`/`bind`, and `Reflect.apply` are tracked. Invoking or escaping a
generated export outside `KernelScratchLease.invokeKernelExport` is a contract
finding even when every argument is an untainted primitive. Independently, the
ownership audit rejects any repository-owned raw kernel-memory view/write and
any unreviewed allocator, reservation, or region-factory call. The narrow exact
raw-call allowances are scalar/no-pointer manifest, ABI, IPC-size, and ioctl
queries plus the scratch core's captured arity inspection. There is no broad
“token-only export” exclusion. The reserved-spawn commit is admitted only by
an exact syntax-tree proof that pairs its begin-derived region and token,
copies before commit, revokes the region, and then cancels that same token.
Allocator and reserver calls retain their separate exact findings. A separate
exact
multiset allowlist admits only named
reviewed occurrences with inline reasons;
adding or duplicating an occurrence fails, and deleting one makes its allowance
stale
and also fails. Framebuffer, process-memory, Rust-lent, and explicit
shared-backing roots remain separately classified because their owner is not
the kernel scratch allocator. A `.set` or `.decode` call counts as a
synchronous reader only when TypeScript resolves it to the native typed-array
or `TextDecoder` declaration; a same-named custom method remains an escape.
JavaScript-family sources retain an additional conservative syntax backstop:
zero-argument `.getMemory()` and `.getInstance()` calls are treated as
potential kernel-memory authorities even when an untyped receiver prevents the
checker from recovering its class. The public kernel facade no longer carries
a memory export, but retaining this rule makes a future raw-accessor regression
visible. The normal ownership analysis follows any such values through aliases
and helper parameters into raw typed-array or `DataView` writes. An unrelated
JavaScript API with the same spelling requires an exact site allowance; no
file is excluded to suppress it.
This is a compiler-backed contract over the reviewed repository source, not a
claim of a sound general-purpose JavaScript taint analysis or control over
memory capabilities obtained outside the supported host API.

Rust has a separate source-contract guard for dispatcher pointers.
`crates/kernel/src/channel_scratch.rs` test
`raw_channel_pointer_allowlist_contains_only_process_addresses` rejects the
former raw-channel-pointer macro, matches every remaining
`process_address!` occurrence against its exact reviewed syscall context, and
checks the total occurrence count. The surviving sites carry guest virtual
addresses for memory-management, clone, futex, and related operations; they do
not authorize kernel-scratch dereferences. Exact contexts plus the count are
both required so removing one approved site and adding an unrelated one cannot
evade review.

### Closed process-address disposition

The pointer audit distinguishes a caller process address from a pointer into
kernel scratch even though both occupy an `i64` channel slot. The authoritative
generated pointer set is
`crates/shared/src/host_abi.rs::SYSCALL_ARG_DESCRIPTORS`, emitted as
`host/src/generated/abi.ts::SYSCALL_ARGS`. `host/test/generated-abi.test.ts`
pins that complete generated set to the ABI snapshot and requires every
descriptor to be explicitly required or nullable. The host planner iterates
that table, captures the caller range, and replaces every non-null descriptor
slot with a lease-scoped allocator-owned address;
`crates/kernel/src/channel_scratch.rs::validate_channel_scratch_arguments`
recomputes the same layout before dispatch. Zero-size argument records receive
the allocator-owned empty address rather than forwarding an ignored process
pointer. The only generated-table bypasses are:

- `read(3)`, `write(4)`, `pread(64)`, and `pwrite(65)`, which use the ordinary
  planner through `CH_DATA_SIZE` and the tokenized exact large-transfer path
  above it;
- `wait4(139)` and `waitid(288)`, whose complete optional outputs are handled
  by the exact host wait path; and
- `execve(211)`, whose path, argument vector, and environment are decoded from
  checked caller ranges before the asynchronous exec boundary.

Every other generated descriptor slot is scratch-overwritten before Rust sees
it. The following table closes the remaining non-generated and conditional
slots. `host/test/channel-scalar-contract.test.ts`,
`host/test/host-process-pointer-width.test.ts`, and the exact Rust raw-pointer
allowlist make additions or lossy width conversions executable drift
failures.

| Disposition | Exact symbols and process-address slots | Ownership and lifetime finding |
|---|---|---|
| **Live raw `ProcessAddress` consumed by Rust** | `host/src/kernel-worker.ts::{checkGeneratedProcessAddressArguments,checkHandwrittenProcessAddressArguments}` and `crates/shared/src/channel_scalar.rs::SYSCALLS` cover `mmap` a0, `munmap` a0, `brk` a0, `mprotect` a0, `mremap` old a0, `madvise` a0, `set_tid_address` a0, `set_robust_list` a0, `get_robust_list` a1/a2, `msync` a0, `mlock`/`mlock2` a0, and `munlock` a0. Rust consumes them only through `checked_channel_process_address`, `dispatch_channel_mmap`, `dispatch_channel_mremap`, `dispatch_channel_wide_result`, or the reviewed `process_address!` macro in `dispatch_channel_syscall`. | These are guest virtual addresses, not kernel allocation addresses. The host first proves caller width and lossless JavaScript indexing; Rust reinterprets the complete physical bits and checks its target width. No such value authorizes a kernel-scratch dereference. `mremap` fixed a4 is separately checked and used only by host mapping pre/postflight; the current Rust syscall does not consume it. |
| **Exact host-intercepted handwritten slots** | `checkHandwrittenProcessAddressArguments` covers spawn a0/a2/a4; execve a0/a1/a2; execveat a1/a2/a3; wait4 a1/a3; waitid a2/a4; futex a0 and operation-dependent a3/a4; vector I/O a1; sendmsg/recvmsg a1; pselect6 a1-a5; select a1-a4; lock-fcntl a2; network-ioctl a2; and large read/write/pread/pwrite a1. | The host validates the complete caller or nested range and either decodes it, copies it to an owned scratch subregion, or retains only detached scalar/byte state. None of these caller pointers reaches Rust as kernel scratch. |
| **Conditional raw values after an exact host intercept** | `handleClone` validates stack a1 and TLS a3 plus active parent/child-TID a2/a4, then its synchronous synthetic channel call lets `dispatch_channel_syscall` consume the exact active process addresses. Direct Rust fallbacks also retain checked conditional slots for futex a4, shmat a1, and shmdt a0; normal production dispatch intercepts those syscalls in `handleFutex`, `handleIpcShmat`, and `handleIpcShmdt`. | Ignored conditional arguments retain scalar/ignored semantics. Active clone pointers are process metadata or checked process-memory destinations, not scratch. The shmat/shmdt host paths keep mapping ownership in the process address space and pass no caller-selected scratch pointer to Rust. |
| **Other exact special paths** | `handleGetgroups`; ppoll timeout/mask decoding around `SYS_PPOLL`; `handleEpollCtl`/`handleEpollPwait`; `handleSysvMessage`; `handleIpcControl`; `handleSemctl`; option-sensitive `PR_SET_NAME`/`PR_GET_NAME`; and request-sensitive ioctl planning. | Each special path proves its caller-native fixed, nested, or command-dependent shape before staging. Ppoll's generated pollfd a0 is scratch-overwritten while its timeout and mask become scalars. Unknown, scalar, and no-argument ioctls stage no pointer. `epoll_pwait` currently validates the optional mask range although its contents are not yet applied; that semantic gap does not grant scratch authority. |
| **Nested process addresses inside an overwritten ioctl record** | `crates/shared/src/ioctl_contract.rs`, `crates/kernel/src/syscalls.rs::{handle_dri_ioctl,handle_dri_card_ioctl,checked_dri_process_pointer}`, and the process-memory `HostIO` bridge. | The outer ioctl argument is an exact scratch-overwritten record, but selected DRM/KMS/GL records contain nested process addresses that remain process addresses. Rust validates their current bridge representation before any process-memory write. The present `u32` bridge rejects a wasm64 nested address above 4 GiB; that is an explicit mixed-width device limitation, not permission to reinterpret it as kernel scratch. |

`SYS_SIGNAL` a1 is deliberately absent from the raw-address set: it is a
`u32` WebAssembly function-table index, not a process linear-memory address.
The xattr stubs below are also not silently classified as pointers merely
because their future implementations will need buffers.

### Native-width scalar and legacy direct-import evidence

The channel carries six physical `i64` words, but each word still has the
syscall's real domain. `crates/shared/src/channel_scalar.rs` is the
authoritative exception table: it distinguishes caller-width pointers,
caller-width `size_t`, exact `u32`, complete `i64`, and split `i64`. The host
starts from untouched `bigint` words and never narrows an exact slot merely for
logging. It validates addresses before host use; Rust consumes the matching
typed helper and either represents the complete value or rejects it before
effects. Descriptor-backed counts are handled separately: the host validates
their raw caller range and replaces the pointer and count with one
capacity-owned staged extent.

| Surface and exact symbols | True width and old boundary reproduction | Current disposition |
|---|---|---|
| Memory-management lengths for `mmap`, `munmap`, `mprotect`, `mremap`, `madvise`, `msync`, `mlock`, `mlock2`, and `munlock`; `ChannelScalarKind::ProcessSize`; `checked_channel_process_size` | The length is `size_t`. On the live lock path, `addr=0,len=0x1_0000_1000` formerly became 4,096; a high address such as `0x1_0000_1000` could likewise alias `0x1000`. | The preceding pointer table and `ProcessSize` jointly preserve both fields. `msync` and advisory memory operations validate even where the current operation is a no-op, so a future implementation cannot inherit the alias. |
| `set_tid_address(203)` and robust-list syscalls 261/262; `kernel_set_tid_address`, `kernel_{set,get}_robust_list` | Clear-TID and robust-list slots are process pointers; robust-list length is `size_t`. A high clear-TID pointer could formerly be stored as the low address. Robust-list exports currently retain/write nothing, so their same defect was latent rather than a live overwrite. | `ProcessAddress`/`ProcessSize` reject a lossy value. Exact validation is retained for the robust no-op/`ENOSYS` surface before it gains effects. |
| `shmget(344)`; `SHMGET_ARGUMENTS`; `u32::try_from(process_size!(1))` | Slot 1 is `size_t`, while the current segment implementation has a separate `u32` ceiling. `0x1_0000_1000` formerly allocated 4,096 bytes. | Preserve the native value first, then reject it if the implementation cannot represent it. No segment is allocated from an aliased low word. |
| `sendfile(294)`, `copy_file_range(290)`, and `splice(291)`; `reportable_channel_transfer_count` | Count is `size_t`, but a successful channel result is signed `i32`. Preserving a request above `i32::MAX` and casting the completed byte count afterward could publish a negative errno-looking result after effects. | These operations permit a short result, so work is capped at `MAX_REPORTABLE_TRANSFER_BYTES = i32::MAX` before reading, writing, consuming input, or advancing offsets. Exact and cap+1 helper tests exercise this without allocating 2 GiB. |
| `readahead(293)` | Slot 2 is `size_t`; the advisory implementation currently has no data effect. | `ProcessSize` is still validated. No-op is a disposition, not permission to truncate future input. |
| `signalfd4(246)`, `signalfd(377)`, `epoll_pwait(241)`, `ppoll(251)`, and the native `{ sigset_t *, size_t }` nested in `pselect6` | Signal-set width carriers are native `size_t`; low-word parsing could make a malformed wasm64 width appear to equal eight. | Direct slots use `ProcessSize`; the bespoke nested parser preserves the caller-native field. A non-null mask must still have the generated exact signal-mask width. |
| `sched_setaffinity(237)` and `sched_getaffinity(238)` | Linux's raw parameter is `unsigned int`, not the public musl wrapper's `size_t` (`kernel/sched/syscalls.c` declares `sched_getaffinity(pid_t, unsigned int, ...)`). | Intentionally `U32` and consumed through `u32_argument`. Widening it would invent an ABI rather than fix truncation. |
| Legacy `signal(73)`; `SIGNAL_ARGUMENTS`; `exact_u32_argument`; `kernel_signal` | Handler a1 is Kandelo's supported `u32` WebAssembly function-table index, not a linear-memory pointer. `0x1_0000_0001` formerly aliased index 1. | `ExactU32` rejects nonzero high bits, matching the existing wasm64 `sigaction` translator. A larger table-index domain would be a separate ABI decision. |
| Descriptor-planned read/write, socket, polling, pathname, message, and vector counts | Public counts may be `size_t`; they must not pass through JavaScript `Number` or a low-word scalar merely because the final transport is bounded. | `#handleSyscallInner` computes argument extents from `rawArgs`, checks safe arithmetic and the caller range, then publishes only the exact capacity-proven staged extent. The next subsection records which operations may legally be short. |
| `mincore`, `tee`, `vmsplice`, `process_vm_{readv,writev}`, xattr operations, and `remap_file_pages` | Their documented pointers/counts remain native, but current Rust stubs do not dereference or write them. | Reviewed stub/`ENOSYS` or no-effect disposition only. A real implementation must add the checked ownership path before its raw-pointer allowance is removed. |

The historical direct C dispatcher was scanned separately because changing a
C type can change a Wasm function signature even when the channel is
unchanged.

| Direct C/import/export group | Evidence and disposition | ABI conclusion |
|---|---|---|
| `kernel_signalfd4`, `kernel_sendfile`, `kernel_set_tid_address`, and `kernel_{set,get}_robust_list` in `libc/glue/{syscall_imports.h,syscall_glue.c}`; matching `wasm_api.rs` exports | Declarations now use `size_t`/`uintptr_t` where the syscall does; `kernel_signal` deliberately uses `u32`. | The shipped kernel target is wasm32, so these types still lower to the existing `i32` signatures. `abi/snapshot.json` retains `kernel_sendfile: (i32,i32,i32,i32) -> i32`, identical to `HEAD`; no extra bump follows solely from the source-type correction. |
| Direct path/string/record/buffer imports declared with C pointers | Those addresses belong to process memory, while the matching Rust exports dereference kernel memory and historically carried no allocation capacity. Updating pointer spelling cannot bridge the two address spaces. | The supported channel descriptor or bespoke path copies through a checked kernel-owned region. The legacy direct operation remains rejected; it is not an alternate scratch protocol. |
| Direct `epoll_pwait`, `ppoll`, and `pselect6` signal-mask widths | `syscall_glue.c` compares the native `size_t` carrier with the fixed mask width before calling an export that does not carry that size; `pselect6` reads its native nested `{ pointer, size_t }` record. | This source check does not add an export parameter or change the shipped wasm32 snapshot. The supported channel path independently validates the same native-width contract. |
| Direct `kernel_{mmap,munmap,mprotect,mremap,madvise}`, futex, and clone calls | Rust memory exports use `usize`, while the historical C dispatcher still declares/casts raw `u32` addresses and lengths; its futex/clone process pointers are also `u32`. | This is **not** a wasm64-safe direct interface. A future distributable wasm64 kernel would lower `usize` to `i64` and require an explicit export/signature ABI decision. |
| Stale direct `kernel_ipc_shmget(int32_t key, int32_t size, ...)` | No matching Rust export or snapshot entry exists; the supported channel path is the exact `ProcessSize` implementation above. A complete legacy `syscall_glue.c` artifact requests unsupported `kernel.*` functions and `assertSupportedKernelFunctionImports` rejects it before instantiation. Current SDK, program, libc, POSIX, Sortix, and browser build scripts link `channel_syscall.c`. | `worker-kernel-import-contract.test.ts` pins the fail-before-instantiation policy; the stale declaration is not treated as a compatibility API. The direct source edits add no ABI epoch beyond ABI 43 and do not hide a future wasm64 signature change under today's wasm32 snapshot. |

The option-sensitive `prctl` numbers and name width, the Fcntl lock-record
width, and the signal-mask width are also cross-layer marshalling contracts.
They are defined once in the `prctl` and `kernel_scratch_wire` modules in
`crates/shared/src/lib.rs`, emitted by `tools/xtask/src/dump_abi.rs`, and
consumed from `host/src/generated/abi.ts`; the host and Rust validators do not
repeat numeric literals. This generation-only deduplication does not itself
require an ABI bump.

For generic descriptor staging, the host first captures every `Deref`-derived
caller `u32`, then uses that same value to size the companion buffer and stage
the length record. This makes planning independent of generated descriptor
order and leaves no second guest-memory read that another process thread could
replace. Rust independently proves canonical pointer order, alignment,
non-overlap, and allocation bounds from the staged descriptor values. The
generic aligned wire does not, however, carry a separate unpadded capacity for
each descriptor. Rust therefore cannot reconstruct a hypothetical
host-planned capacity change that stays inside one eight-byte alignment
bucket. The exact capacity authority is the host's captured value under the
single synchronous, non-reentrant lease. Adding an independent
per-suballocation capacity would require a further ABI field (or removing the
alignment slack); this audit does not overstate the information available to
the current Rust validator.

### Generic argument-sized capacity is not permission to shorten

`CentralizedKernelWorker.#handleSyscallInner` plans generated
`SyscallArgSize::Arg` records in `host/src/kernel-worker.ts`. When an otherwise
simple one-byte multiplier would cross `CH_DATA_SIZE`, the historical generic
fallback reduced both the staged extent and the count visible to Rust. That is
memory-safe only when the syscall is permitted to perform that shorter
operation. It is not a general ownership rule: an atomic message, socket
address, option object, or complete-or-error result cannot be made safe merely
by changing the caller's count.

The following is the closed audit of every simple generated `Arg` record.
“Bounded contract” means shortening is not the reason the path is safe; a
separate generated platform maximum proves that a valid result can never
reach the fallback. Those maxima need exact-boundary and drift coverage.

| Syscall and generated pointer/count slots | Short-operation disposition | Required ownership/capacity action and WHY | Focused executable evidence |
|---|---|---|---|
| `read(3)` `a1/a2`; `write(4)` `a1/a2`; `pread(64)` `a1/a2`; `pwrite(65)` `a1/a2` | The ordinary descriptor is never shortened: a count above `CH_DATA_SIZE` diverts before generic planning to `#handleLargeRead` or `#handleLargeWrite`. | Keep the one-operation Rust-owned large-transfer reservation. This is required even though ordinary files and streams may return short: `read`/`write` can name a datagram socket, and splitting or pre-shortening would change one message. | Existing exact/capacity+1 scalar and vector transfer tests cover reservation failure, sequential/interleaved attempts, wasm32/wasm64 ranges, and one-datagram behavior. Retain a direct scalar datagram boundary case. |
| `getrandom(120)` `a0/a1`; `getdents64(122)` `a1/a2` | **Short operation permitted.** Random generation may return a prefix. `getdents64` may return a whole-record prefix and resume at the next cookie. | The generic count cap is semantically legal only for these two records. `getdents64` must retain its pending-entry/cookie invariant so an entry is never split or lost. | Cover channel capacity and capacity+1. The directory case must prove every returned record is complete and the following call returns the unconsumed suffix. |
| `getcwd(23)` `a0/a1` | **Complete-or-`ERANGE`, not short.** A canonical CWD may exceed generated `PATH_MAX`: that limit applies to one caller-supplied pathname, not the absolute spelling formed from an already-deep directory. | Preserve the caller's real output capacity. The generic fixed-or-tokenized planner lends that complete extent, and Rust writes the whole CWD plus NUL or returns `ERANGE` without mutation. Total kernel memory beyond the selected allocation grants no extra capacity. | Exercise a canonical CWD larger than `PATH_MAX`, exact capacity and one short with unchanged bytes, and caller capacities at channel capacity and capacity+1. |
| `realpath(109)` path `a0`, output `a1/a2` | **Complete-or-`ERANGE`, not short.** The caller-supplied input remains bounded by generated `PATH_MAX`, but resolving it against a deep CWD may produce a longer canonical result. | Stage the bounded input plus the caller's actual output capacity through the fixed-or-tokenized owned layout. Rust either publishes the complete canonical path or leaves a short destination untouched; an internal channel remainder cannot become a second path limit. | Exercise a `PATH_MAX`-valid relative input whose canonical result exceeds `PATH_MAX`, exact/one-short output capacities, and channel capacity/capacity+1. |
| legacy `readdir(26)` fixed record `a1`, name `a2/a3` | **Bounded contract, not short.** One 16-byte record plus a `NAME_MAX` (255) name fits. | Preserve the generated/namespace `NAME_MAX` relationship and require the host iterator to return one complete name. A shortened name after advancing the iterator would lose directory state. | Exact 255-byte name, 254-byte destination failure behavior, and channel-capacity+1 caller capacity with one complete entry. |
| `readlink(19)` path `a0`, output `a1/a2`; `readlinkat(102)` path `a1`, output `a2/a3` | **Must not generically shorten.** The caller's `bufsiz`, not an internal transport cap, decides whether POSIX truncation occurs. Direct readlink does not impose `PATH_MAX`, and `_PC_SYMLINK_MAX` is currently indeterminate. | Use an exact/large owned region, or define and enforce a real cross-layer symbolic-link target maximum that leaves room for the path. “Readlink may truncate” is not permission to truncate a target that fits the caller's actual buffer. | Create or inject a target larger than the ordinary remaining channel extent but smaller than caller `bufsiz`; require the complete target. Also cover exact caller capacity and capacity-1 truncation. |
| `getenv(43)` name `a0`, output `a1/a2` | **Confirmed live false-`ERANGE` edge.** The operation is complete-or-`ERANGE`; it does not return a prefix. A process metadata entry may occupy 65,536 bytes, while the name and eight-byte alignment leave less output space. | Use aggregate exact/large ownership or reduce and document the metadata-entry contract consistently at every admission point. Do not silently lower only this call's capacity. | Install a maximum entry such as `X=` plus a value that fits the current metadata-entry ceiling. A caller buffer that holds the value must receive it; exact value capacity succeeds and one byte less returns `ERANGE`. |
| `mq_timedsend(333)` message `a1/a2`; `mq_timedreceive(334)` destination `a1/a2` | **Confirmed atomic-message defect.** Send must enqueue the complete message or fail. Receive must compare the caller's real capacity with the authoritative open queue's `mq_msgsize` before dequeue. | Query `mq_msgsize` before allocation: report `EMSGSIZE` for an oversized send or undersized receive, stage exactly the queue maximum for receive, and route the complete message plus priority/timeout records through the fixed-or-tokenized capacity-owned channel. Rust caps queue creation at the reportable-result domain and makes allocation failure atomic. The generic immutable snapshot freezes the request/deadline while Rust pins the exact mqueue descriptor. | Queue `mq_msgsize` at fixed-channel capacity and capacity+1; send exact/+1, receive exact/+1, verify no prefix enqueue, no dequeue on `EMSGSIZE`, allocation failure before mutation, sequential reuse, blocked-wake immutability, and descriptor close/reuse. |
| `bind(51)` `a1/a2`; `connect(54)` `a1/a2` | **Confirmed all-or-nothing and family-discriminator defects.** A socket address is not a short byte stream, and bytes from one family must not be interpreted as another family's port, path, or registry key. | Validate the embedded `sa_family` plus family-specific minimum and maximum native `sockaddr` lengths before copying or performing any port allocation, VFS lookup/create, AF_UNIX registry operation, host dispatch, or socket-state mutation. Do not allocate a caller-requested giant address or change its length to the channel remainder. | `test_bind_inet_stream_validates_sockaddr_before_state_mutation`, `test_bind_unix_validates_family_before_vfs_or_registry_mutation`, `test_connect_inet_stream_validates_sockaddr_before_host_or_state_mutation`, and `test_unix_stream_connect_validates_family_before_resolution_or_state_mutation` cover wrong-family no-state/no-host-effect rejection followed by a matching-family control. Exact maxima/+1 retain the independent capacity boundary. |
| `setsockopt(59)` `a3/a4` | **All-or-nothing option object.** Supported scalar, timeout, linger, string, and multicast records have option-specific layouts; no “short setsockopt” result exists. | The host rejects input above the generated 264-byte maximum, stages the complete admitted extent, and carries the independently known process width in the private sixth channel slot. Rust accepts only width 4 or 8 and selects the generated `group_req`/`group_source_req` layouts (132/260 bytes on wasm32, 136/264 on wasm64). `optlen` and padding cannot choose the data model. | Exact/short/long cases cover every structured option and all 12 IPv4 multicast operations on both widths. A 264-byte padded input cannot steer wasm32 parsing, while 265 rejects before scratch mutation or dispatch. |
| `send(55)` `a1/a2` | **Must preserve one operation.** Stream sends may return short, but the same syscall sends atomic datagrams. | Route the real count through the Rust-owned large transaction, or perform an authoritative socket-type/datagram-limit preflight before any count rewrite. A generic prefix success is invalid. | AF_UNIX and IP datagram at channel capacity/+1: receive either the complete one message or observe the correct error, never a successful prefix. Retain a stream short-send case. |
| `recv(56)` `a1/a2` | **Must preserve the caller's capacity.** Streams may return short; datagram receive consumes one message and reports truncation relative to the caller's buffer. | Use an exact region, or generate/enforce a datagram ceiling no greater than the independently staged capacity. An internal cap must not create `MSG_TRUNC` or discard bytes that fit the caller's actual buffer. | Queue a datagram at the supported maximum and receive into capacity, capacity-1, and channel-capacity+1 buffers with/without `MSG_PEEK` and `MSG_TRUNC`. |
| `sendto(62)` payload `a1/a2`, address `a4/a5` | **Confirmed aggregate-capacity and family-discriminator defects.** Payload is one datagram, the address is one native object, and a wrong family must not trigger implicit bind or host delivery. | Plan one checked aggregate region for the exact payload plus a bounded native address, then validate `sa_family` before ephemeral-port allocation, socket mutation, registry lookup, or host dispatch. The old descriptor order could let payload consume the channel, reduce address length to zero, and change the destination or produce `EDESTADDRREQ`. | `test_sendto_validates_sockaddr_before_datagram_state_mutation` proves wrong-family and short addresses preserve unbound state, port allocation, and host-call counts for AF_INET and AF_UNIX. Maximum payload/address aggregate exact/+1 and an unconnected socket retain the capacity and no-zero-address cases. |
| `recvfrom(63)` destination `a1/a2`, address `a4` via `*a5` | **One message plus value-result address.** Shortening data can discard a datagram the caller could hold; reserving the caller's entire address capacity can reject before receiving even though the actual address is small. | Plan exact data capacity plus `min(caller address capacity, supported sockaddr maximum)` in one owned aggregate. Copy back only the detached actual address and length. | Maximum datagram with non-null address, data/address aggregate exact/+1, caller address capacity above channel size, truncation/peek, and no dequeue on preflight failure. |

The related generated `Deref` value-result paths do not use the simple cap:
`accept(53)`/`accept4(384)` address `a1` via `*a2`,
`getsockopt(58)` option output `a3` via `*a4`,
`getsockname(114)`/`getpeername(115)` address `a1` via `*a2`, and the
`recvfrom(63)` source address above. Generic planning currently reserves the
caller's entire advertised capacity and returns `EINVAL` when it exceeds the
remaining channel, even though the implementation can produce only a small,
known result (currently at most the 232-byte `TCP_INFO` or a supported native
socket address). These paths must stage
`min(caller capacity, generated supported-output maximum)`, preserve the
captured value-result semantics, and copy back only the actual detached bytes.
Focused regressions must pass an otherwise valid capacity of
`CH_DATA_SIZE + 1`, preserve canaries, and prove that a rejected accept does
not consume or leak the pending connection.

The xattr syscall numbers 350–359 currently have no generated pointer
descriptors, and their Rust stubs do not dereference or write their pointer
slots (`get` returns `ENODATA`, `list` returns zero, and `set` currently
returns success). They are capacity-safe only because the surface is not
implemented, not because a raw pointer or partial xattr is valid. Keep these
exact stubs on the reviewed raw-pointer/static-contract allowlist until a
truthful implementation exists. A future get/list operation is
complete-or-`ERANGE`, and set is an all-or-nothing input; each must enter the
checked ownership abstraction before the stub allowance is removed.

## Allocation inventory

The last column records current source safety and a coverage pointer only; it
does not record validation readiness. Reviewed exclusions are outside this
abstraction because they have a different owner or lifetime, not because they
are assumed safe. Mutable exact-head validation status is recorded in the
draft PR ledger, independently of these source-safety rows.

| Region and symbols | Allocating owner; pointer/capacity | Maximum accepted source | Lifetime and overlap | Hosts / widths | Historical audited-head finding | Current safety disposition and coverage notes |
|---|---|---|---|---|---|---|
| Raw allocator boundary, `crates/kernel/src/wasm_api.rs::kernel_alloc_scratch`; `crates/kernel/src/scratch_alloc.rs::layout` | Rust global allocator; successful pointer owns exactly the validated `Layout` size | The export accepts a `u32` request, but a successful allocation is further bounded by the aligned Rust `Layout`/`isize::MAX` domain | Allocation is retained for the kernel lifetime; no host-side free or growth workaround | Node/browser; wasm32/64 kernel | **Unsafe failure boundary.** Invalid `Layout` construction could trap instead of reporting allocation failure | **Implemented; validation pending.** Zero/invalid layouts and allocator-null return zero; the host rejects an invalid zero or out-of-memory-range result before constructing a region |
| Main syscall scratch, `CentralizedKernelWorker.#scratchRegion` | Rust `kernel_alloc_scratch`; `KernelScratchRegion`, 65,608 bytes (`CH_TOTAL_SIZE`) | Each layout is checked against the region; ordinary data payload is at most 65,536 bytes (`CH_DATA_SIZE`) | Kernel lifetime; one synchronous lease per dispatch/copy; nested leases fail | Node and browser; wasm32/64 kernel | **Unsafe contract.** Bare `scratchOffset`; several live overflows | **Implemented; validation pending.** All allocator-owned access is lease-mediated, and reflection cannot recover the region |
| Generic widened transfer scratch, `crates/kernel/src/transfer.rs::{TransferScratch,GlobalTransferScratch}`; `kernel_transfer_scratch_{begin,pointer,capacity,cancel}`; `kernel_transfer_{channel,io}_execute`; complete CWD/fd/dirfd path producers | Rust owns a fresh initialized, eight-byte-aligned `Vec<u64>` byte prefix. A positive opaque token is the sole authority for its pointer and exact authorized byte capacity; spare vector capacity is never exposed | The allocator boundary is generated `MAX_TRANSFER_ALLOCATION_BYTES` (`u32::MAX`). Each consumer applies its narrower semantic/result ceiling before effects, including `MAX_REPORTABLE_TRANSFER_BYTES` for scalar/vector, message, and canonical-path output | Widened syscall/channel calls use one exclusive Reserved → Executing → Ready transaction. Executing rejects begin/query/cancel/reuse; a trap leaves ownership uncertain and fail-stops the generation. Complete canonical-path reads instead keep the token Reserved for one synchronous Rust producer, detach the exact result, revoke the host region, and cancel/drop the vector. Reserved prevents movement or replacement, and the host reentry guard excludes a second reservation; no promise or callback observes the live bytes | Node/browser shared host path; kernel wasm32/64 and guest wasm32/64 | **Missing on the audited head.** Variable transfers either overfilled the fixed mailbox or required a protocol-specific large allocation | **Capacity-safe in current source; static-contract rerun pending.** Rust proves base alignment, initialized exact capacity, allocation failure, token exhaustion, sequential/interleaved exclusion, and invalid state transitions. Focused path coverage additionally targets zero-capacity query, exact/short/no-mutation, detach/revoke/cancel, allocation failure, and canonical output above `PATH_MAX`. The host must still receive a clean final rerun of the reservation-authority and entry-context gates before this row can be called validated |
| TCP/pipe scratch, `CentralizedKernelWorker.#tcpScratchRegion` and `#requireTcpScratchRegion` | Rust `kernel_alloc_scratch`; `KernelScratchRegion`, 65,536 bytes | One checked transport chunk, at most 65,536 bytes | Kernel lifetime; worker callbacks/messages detach bytes before yielding | Node/browser; wasm32/64 kernel | **Safe sizes, weak contract.** Private pointer reached other code | **Implemented; validation pending.** The region and accessor are runtime-private and all access is synchronously leased |
| Large spawn scratch, `beginLargeSpawnScratch`, `SpawnScratchBuffer` | Rust `Vec<u8>` through required `kernel_spawn_scratch_begin/pointer/capacity/cancel`; the returned token gates both pointer and capacity, while separate pointer-free retained-capacity telemetry grants no write authority | Complete blob at most 8,417,320 bytes; ordinary blobs use main scratch | Kernel-lifetime high-water allocation, but a fresh exclusive token and single-use host region per operation. Begin and queries are nonblocking; begin may move only while idle. After every successful begin, host cleanup runs in `finally`. Commit/cancel wait on the same no-import lock and return with a definitive token state; cleanup failure is fatal and leaves the host reentry guard closed | Node/browser; wasm32/64 kernel | **Safe after #1094, weak contract.** Fixed 8,417,320-byte allocation retained after first large use | **Safe in current source.** `kernel_spawn_reserved_process` accepts token+length rather than a bare pointer, with no ABI-42 fallback. This document makes no retained-memory or performance claim |
| Audio drain, `WasmPosixKernel.#audioScratchRegion` | Rust `kernel_alloc_scratch`; 65,536-byte `KernelScratchRegion` bound to the exact Wasm instance and memory that allocated it | `min(out.byteLength, capacity)` and checked Rust return count | One kernel-wrapper generation; one synchronous drain lease. `init` is one-shot, and the cached region is runtime-private, so it cannot survive an instance replacement or escape to a caller | Node/browser; wasm32/64 kernel | **Confirmed unsafe/uncertain.** Pointer/range and producer count were incomplete, and a later second initialization could leave the cached region bound to the old generation | **Safe in current source.** Allocation, requested bytes, current range, returned count, and one-generation lifetime are checked |
| Public wrapper temporary storage, `WasmPosixKernel.#apiScratchRegion` | Rust `kernel_alloc_scratch`; 65,536-byte `KernelScratchRegion` bound to one exact kernel generation | Each socket/poll/terminal/ioctl/uname/pipe/rusage/select request must fit | One kernel-wrapper generation; synchronous public-call lease. Concurrent or post-success initialization rejects before state mutation; a failed first attempt clears partial state and remains retryable | Node/browser; wasm32/64 kernel | **Confirmed unsafe.** Hard-coded addresses 4 and 16 were not allocations, and later reinitialization could pair an old cached region with a new memory/instance | **Safe in current source.** All temporary public API storage is allocator-owned, runtime-private, and cannot outlive its generation |
| Rust-lent host-import destinations, `checkedWasmImportMemoryRange`, `WasmPosixKernel.#readKernelBytes`, `#writeKernelBytes` | Rust slice/local/struct; pointer plus explicit capacity, or a generated authoritative fixed-format size such as the 68-byte KMS mode record, for one import call | Genuine producer span no larger than the Rust-supplied or generated capacity | Only the synchronous import; backend data is staged in host-owned memory and no kernel view is lent or retained | Node/browser; wasm32/64 kernel | **Valid ownership, incomplete checks.** Lossy conversions, live-view lending, and clamping writes existed | **Implemented; validation pending.** Signed-wasm32/wasm64 pointer normalization, complete range, intrinsic producer span, detached/staged backend I/O, and producer/result length precede one publish |
| Public kernel authority boundary, `WasmPosixKernel`, `CentralizedKernelWorker`; `KernelEntryGate`; frozen lexical `KernelWorkerEntryContext`; internal `getWasmPosixKernelRuntimeAccess` and module-secret method-only test companions | Public callers receive no instance, export namespace, Memory, import object, scratch region, or region factory. A selected worker ingress receives only one exact gate/scope-bound facade plus a gate-owned post-revocation protocol/observer registrar; the worker stores no ambient current context | No public mutable-memory transfer surface; every synchronous export-bearing helper must receive the exact lexical context, and every later callback must open a fresh ingress | Result-bearing reentry throws. Void ingress is FIFO-queued until the active export and scratch lease unwind. Immediate-only ingress rejects reentry without queueing or retaining caller values. Typed effects run only after scope revocation; serialized host-only operations reject Promise/thenable escape; retained context/export closures, cross-gate scopes, callback export attempts, and rebinding one raw instance or Memory to another generation fail. Runtime-private fields resist reflection. Test-only construction installs frozen exact method companions rather than target-bearing proxies, and those capabilities remain absent from supported host API entry points | Node/browser; wasm32/64 kernel | Existing public accessors and TypeScript-only private fields exposed raw Memory/instance/scratch authority. Interim production and test proxies were also rejected: a synchronously reentrant backend callback could call the production target directly, while a target-bearing test proxy preserved arbitrary binding and mutation authority inside runtime source | **Static-contract validation pending.** Earlier focused gate, reflection, API-entry, test-companion, PTY, FUTEX, and real-worker cases are evidence for their exact source checkpoints. The widened reservation detector and rigid stage → execute → finish helper changed afterward, so neither the kernel-memory ownership gate nor the entry-context gate is recorded as clean until both are rerun on the stabilized source |

## Transfer inventory

“Synchronous” below means that no promise, worker-message yield, or callback
boundary can occur while Rust is expected to consume the staged bytes.
Single-threaded event-loop execution is not used as a substitute for capacity
or range validation. The last column records current source safety and coverage
only. Its mutable exact-head validation status is recorded in the draft PR
ledger.

### Blocking-retry ownership and lifetime disposition

Blocking retries matter to this audit because bytes staged in reusable scratch
must not survive into a promise, timer, callback, or later channel use. After a
first `EAGAIN`, the host retains only detached request values in the exhaustive
`BlockingRetrySnapshot` union. The flattened scalar/vector forms retain their
input bytes or process-memory output destinations, and message forms retain
their detached nested records. A replay acquires a fresh fixed or reserved
scratch lease, stages the snapshot, executes synchronously, detaches output,
and releases the lease before waiting again.

Rust remains the single authority for stable target ownership.
`BlockingRetryState::token_for_syscall` returns the opaque positive token for
the exact `(pid, tid, normalized operation)` binding created after the first
`EAGAIN`, or zero for a host-only immutable snapshot. A mapped operation
without a binding fails closed. Terminal completion, cancellation, exact
channel retirement, exec, task exit, and process removal consume the Rust
binding before the host forgets the snapshot, so a reused numeric descriptor
or channel cannot redirect a replay.

ABI 43 also assigns the existing 72-byte channel header's former reserved
`u32` at offset 68 to generated `request_flags`. Libc publishes the generated
cancellation-point and wake-allowed bits before `PENDING`; the host captures
and clears them exactly once, rejects unknown combinations, and freezes them
with the detached retry request. This is part of the async ownership proof:
mailbox reuse cannot replace the cancellation policy of a request whose
scratch lease has already ended.

| Exact files / symbols | Ownership and lifetime proof | Disposition |
|---|---|---|
| `libc/glue/channel_syscall.c::{__do_syscall_impl,__syscall_cp}`; `crates/shared/src/lib.rs::channel`; generated C/TypeScript ABI constants; `host/src/kernel-worker.ts::#captureChannelRequest` | Generated `request_flags` are published before `PENDING`, consumed and cleared once, validated, and retained only as detached scalars with the represented request | **Safe in current source; generated-file drift and sequential mailbox reuse remain exact-head validation targets** |
| `host/src/kernel-worker.ts::{BlockingRetrySnapshot,#rememberBlockingRetrySnapshot,#replayBlockingRetrySnapshot,#releaseBlockingRetrySnapshot}` | All seven shapes retain detached values only. A retry creates a new synchronous scratch transaction; no lease, native view, or pointer crosses the wait. Rust returns either the exact positive token or zero, and terminal completion releases a positive binding before deleting the host snapshot | **Safe in current source; exact-head execution not claimed here** |
| `crates/kernel/src/blocked_retry.rs::{BlockingRetryOperation::from_syscall,BlockingRetryState::token_for_syscall,take_exact,take_for_tid,take_all}`; `crates/kernel/src/wasm_api.rs::{kernel_blocking_retry_token,kernel_blocking_retry_release}` | Rust owns the only target-classification table. Positive tokens never name an fd/pointer and are consumed exactly once; zero is permitted only for an unmapped host-only snapshot | **Safe in current source; drift coverage targets the single-authority rule** |
| `host/src/kernel-worker.ts::{retireExactChannelAsyncState,retireAsyncChannelsForProcess}`; `crates/kernel/src/syscalls.rs::{cleanup_exiting_thread,release_all_blocking_retry_bindings,discard_blocking_retry_bindings_for_process_removal}` | Exact channel, task, and process lifecycle boundaries release the snapshot and Rust-owned pin once, after any active synchronous scratch transaction has settled | **Safe in current source; sequential, interleaved, exec, task-exit, and process-exit regressions are required targets** |

| File / exact symbols | Owner; pointer and declared capacity | Maximum accepted source and origin | Capacity, range, and pointer proof | Synchronous use / overlap | Hosts / widths | Historical audited-head finding | Current safety disposition and coverage notes |
|---|---|---|---|---|---|---|---|
| `host/src/kernel-worker.ts::pollWaitableChild`; `crates/kernel/src/wasm_api.rs::kernel_wait_child_poll`; `crates/shared/src/lib.rs::{KernelWaitResult,KERNEL_WAIT_RESULT_SIZE}` | Rust main allocation; one `KernelScratchLease` lends `STRUCT_SIZE_KERNEL_WAIT_RESULT` bytes (160) and passes the same explicit capacity to Rust | Exactly one fixed 160-byte wait-result record generated from the shared `KernelWaitResult` layout | The lease proves allocator ownership, allocation capacity, current-memory bounds, and lossless kernel-width conversion. Rust rejects pointer zero with `EFAULT` and every capacity other than 160 with `EINVAL` before task validation or waitable-child selection | One synchronous poll and detached decode inside the lease. Rejected output ranges cannot select or consume the sole event; a successful non-`WNOWAIT` call publishes the complete record and reaps atomically | Node/browser shared path; kernel wasm32/64. The shipped real-Wasm regression executes wasm32, and host mocks exercise bigint pointer handling | **Unsafe ABI-42 contract.** The export accepted a bare result pointer, so the host/Rust boundary could not prove that 160 writable bytes belonged to the allocation before selecting the child event | **Safe in current source.** The real-Wasm regression covers pointer zero, capacities 159/160/161, canaries, rejected-call non-consumption, exact-capacity reap, and the following `ECHILD` result |
| `host/src/kernel.ts::{intrinsicBufferSourceSpan,bufferSourceToArrayBuffer,WasmPosixKernel.init}` | Caller supplies kernel module bytes; the host immediately owns one detached `ArrayBuffer` snapshot, then publishes one exact instance/memory generation | Exact intrinsic `ArrayBuffer`, typed-array, or `DataView` byte window accepted by the WebAssembly compiler | Captured native internal-slot getters reject non-genuine/detached sources and ignore subclass span getters; pointer-width detection and compilation consume the same snapshot. An explicit initialization state rejects a concurrent or post-success initializer before it mutates width, memory, instance, or cached scratch authority | Snapshot completes before the asynchronous compile; later caller mutation cannot replace either consumer's bytes. A failed first instantiation clears partial state and permits one clean retry; a successful wrapper is one-shot | Node/browser; kernel wasm32/64 | **Confirmed pointer-width and generation-lifetime defects.** A view subclass could make width detection parse decoy bytes while the engine compiled its intrinsic bytes; a second init could leave cached scratch authorized against the old instance | **Safe in current source.** Spoofed-input, wasm32/wasm64 cached public/audio scratch, rejected reinit, concurrent init, and failed-init retry regressions cover the contract |
| `host/src/host-adapter-manifest.ts::readKernelHostAdapterManifest` | Rust owns one static host-adapter manifest in the exact kernel instance; the export supplies its pointer/length and generated `HOST_ADAPTER_MANIFEST_SIZE` supplies the reviewed read extent | Exactly the generated fixed manifest size; extra exported length grants no larger view | The instance/Memory pair is authenticated first, the export pointer is converted losslessly, and the fixed extent is checked against the current genuine `Memory.buffer` before constructing a private `DataView` | Synchronous scalar reads only; the view and buffer are never returned, stored, or written | Node/browser; kernel wasm32/64 | **Reviewed read-only raw-memory path.** It does not match allocator-owned scratch even though it constructs a view over kernel memory | **Reviewed `kernel-read` exclusion; static-gate rerun pending.** The exact view site is allowlisted because it reads a fixed Rust-owned record after the full range proof and grants no variable-write authority |
| `host/src/kernel.ts::WasmPosixKernel::{#hostFutexWait,#hostFutexWake}` | Rust lends one four-byte aligned atomic word in the kernel's shared `Memory`; no allocator-scratch pointer or variable byte region is involved | Exactly four bytes per import; wake count and timeout are scalars | `checkedWasmImportMemoryRange` normalizes wasm32/wasm64 pointers losslessly, proves the current four-byte range, and requires four-byte alignment before constructing the private `Int32Array`; captured `Atomics.wait`/`notify` intrinsics receive only the proved index | One synchronous import. The atomic view is local and does not escape; wait may block the calling worker but retains no host callback or reusable scratch lease | Node/browser where shared-memory Atomics are supported; kernel wasm32/64 | **Reviewed atomic-control path.** It observes/wakes a Rust-owned futex word rather than copying variable host data | **Reviewed `kernel-control` exclusion; static-gate rerun pending.** The two exact view sites are allowlisted, and neither authorizes `set`, `fill`, `DataView` writes, or a caller-selected scratch capacity |
| `host/src/kernel-worker.ts::{registerProcess,#replaceProcessMetadataWithinKernelEntry}`; `crates/kernel/src/process.rs::{ProcessMetadataReplacement,Process::begin_metadata_replacement,Process::stage_metadata_entry,Process::commit_metadata_replacement,Process::cancel_metadata_replacement}`; `crates/kernel/src/wasm_api.rs::kernel_process_metadata_{begin,stage,commit,cancel}`; `crates/shared/src/lib.rs::process_metadata_contract` | Each host entry uses one lease from the Rust main allocation (65,608 bytes) at allocation-relative offset zero. A positive process-bound token owns separate Rust staging vectors until commit or cancel; the live `Process::argv` and `Process::environ` remain their prior complete values | One encoded entry at most generated `PROCESS_METADATA_ENTRY_MAX_BYTES` (65,536), no more than the generated 4,096 entries per vector, and the complete argv/environment representation at most generated `ARG_MAX`. The sole live caller admits both vectors or neither and validates their caller-width aggregate before begin; there is no second wrapper that can bypass that proof | Detached caller bytes; each lease independently proves owned allocation capacity, current-memory range, and lossless kernel-pointer conversion. Generated kind constants select the staged vector. Rust copies the complete entry synchronously, poisons the token after any matching stage failure, and accepts commit only for the exact live token | One serialized kernel-entry scope spans begin, every per-entry lease/export, and commit. No view crosses an export. Commit performs no fallible allocation or host import between the two vector swaps; every ordinary error runs token cancellation in `finally`, and overlapping/stale tokens reject | Node/browser shared path; kernel and guest wasm32/64 | **Confirmed unsafe ownership and publication defects.** A bare pointer represented ownership, and the former clear-then-push protocol changed live metadata before all later entry allocations had succeeded, so a late `ENOMEM` could leave a visible prefix. Intermediate partial-mask and unvalidated-wrapper designs would also have bypassed the aggregate proof | **Implemented in current source; final validation pending.** Coverage targets success and explicit empty vectors, rejection of exactly-one-vector input before begin, later-environment allocation failure with both old vectors and every layout field intact, exact token/cancel rules, stale and overlapping operations, manifest-required exports, entry/count/aggregate bounds, sequential replacements, post-growth scratch reacquisition, and both kernel pointer widths |
| `host/src/kernel-worker.ts::{handleSpawn,handleExec,handleExecveat,readExecPathFromProcess,readStringArrayFromProcess,resolveExecPathAgainstCwd,#readKernelOwnedPath}`; Rust exports `kernel_get_cwd`, `kernel_get_fd_path`, and `kernel_get_dirfd_path` | Exec/spawn pathname, argv, and environment inputs become detached host values after checked caller-memory reads. Canonical CWD/OFD snapshots first use the 65,608-byte main allocation; an `ERANGE` result selects a fresh exact-capacity Rust-owned `TransferScratch` reservation | Caller path scans remain bounded by generated `PATH_MAX` 4,096, each metadata string by 65,536, and the complete argv/environment representation by generated `ARG_MAX` 4 MiB. Canonical CWD/OFD output is independently allowed through `MAX_REPORTABLE_TRANSFER_BYTES`; it is not `PATH_MAX`-capped | Native pointer-array entries remain at guest width and must convert losslessly; every caller string terminates in its checked range. A positive short path query writes nothing and returns `ERANGE`; zero capacity reports the required length. The host validates that result, reserves exactly when it exceeds main scratch, and passes the reservation-derived pointer and capacity together. Relative `execveat` and shared mappings use the directory-only export, while `AT_EMPTY_PATH` uses the ordinary fd export | Attempt, size query, reserve, exact retry, detach, revoke, and cancel remain in one synchronous kernel entry. Each producer invocation stays lexically inside the exact fixed or reservation-derived lease; no opaque helper receives a transferable lease. The `Vec` stays `Reserved`, so it cannot move or be reused; only detached strings/arrays cross `callbacks.onExec`/`onSpawn` promises. Cancellation drops the allocation before leaving the entry | Node/browser; guest wasm32/64 independent of kernel width | **Unsafe/uncertain edge.** Async exec/spawn resolution used bare fixed-capacity queries, assumed canonical output was at most `PATH_MAX`, and had lossy/incomplete pointer scans | **Safe in current source; final validation pending.** Coverage targets complete main/exact-reserved queries, zero-capacity size discovery, exact/one-short/no-mutation, canonical paths above `PATH_MAX`, regular-file `ENOTDIR`, `AT_EMPTY_PATH`, allocation failure, invalid reservation range, lossless native pointers, and no view across a promise |
| `host/src/kernel-worker.ts::{ptyMasterWrite,ptyMasterRead}` | Rust main allocation, full 65,608-byte region | Write chunks are `min(remaining, lease.capacity)`; read request is `min(4,096, lease.capacity)` | Write source slice and destination are independently checked; returned write/read count must be a safe integer no larger than the offered chunk/request | One lease per chunk/call; read bytes are detached before `drainPtyOutput`; a second operation cannot enter the active lease | Node/browser; kernel wasm32/64 | **Confirmed unsafe.** `ptyMasterWrite` copied arbitrary `data.length` into the allocation; read trusted the producer count | **Implemented; validation pending.** Exact 65,608 and 65,609 regression |
| `host/src/kernel-worker.ts::setCwd` | Rust main allocation, 65,608 bytes | Encoded path must be shorter than generated `POSIX_PATH_MAX_BYTES` (4,096, including the NUL contract) | Length is rejected before acquiring/copying; lease then proves allocation and current-memory bounds | One synchronous lease and `kernel_set_cwd` call; no retained view | Node/browser; kernel wasm32/64 | **Confirmed unsafe.** Copy happened before Rust's `PATH_MAX` rejection | **Implemented; validation pending.** Pre-copy oversized-CWD regression |
| `host/src/kernel-worker.ts::{enumProcs,#enumProcsWithinKernelEntry,parseProcSnapshots,readProcMaps,checkedScratchProducerByteLength}`; `crates/shared/src/lib.rs::process_snapshot_wire`; generated `host/src/generated/abi.ts::PROCESS_SNAPSHOT_*`; `crates/kernel/src/{process_snapshot_wire.rs,wasm_api.rs::kernel_enum_procs}`; fixed wait/wake/mqueue query helpers | Rust main allocation, 65,608 bytes | Process enumeration is one complete four-byte count plus a generated packed 36-byte header and variable `comm`/command-line bytes per live process; other listed producers have their own explicit fixed request | Rust computes and preflights each complete header-plus-payload record with checked arithmetic before any write. A short capacity returns `ENOSPC` without mutation; success slices exactly the required bytes. The generated offsets are the sole Rust/TypeScript authority and the ABI snapshot pins every field. The host rejects non-integer/over-capacity producer counts and malformed count, header, payload length, unsafe virtual size, or trailing bytes | Each producer runs inside one synchronous checked lease and only detached bytes cross a callback or retry boundary. The parser throws before returning any list if any declared record is incomplete, so a valid prefix is never published as the complete process table | Node/browser; kernel/guest wasm32/64 | **Confirmed false-`ENOSPC`, drift, and partial-publication risks.** Enumeration reserved 40 bytes for a header whose wire size is 36; Rust, TypeScript, and tests separately spelled the layout; several producer counts were trusted; and the host silently returned a valid prefix on malformed trailing records | **Safe in current source; final validation pending.** Native full-record exact/one-short/no-mutation tests, generated freshness/drift tests, malformed multi-record host cases, complete-snapshot preflight, and host producer-overreport coverage replace the stale estimate and literals |
| `host/src/kernel-worker.ts::{#handleSyscallInner,#executeCapacityOwnedChannel,#executeReservedChannelDispatch}`; `host/src/generated/abi.ts::SYSCALL_ARGS`; `crates/shared/src/host_abi.rs::{SyscallArgDesc,SyscallArgSize}`; `crates/kernel/src/channel_scratch.rs::{ChannelScratchRegion,validate_channel_scratch_arguments,validate_prctl_layout,checked_cstr_len}`; `crates/kernel/src/wasm_api.rs::{dispatch_channel_syscall,kernel_transfer_channel_execute}` | A complete aligned channel at most 65,608 bytes uses the reusable main allocation; a larger footprint uses one fresh token-bound `TransferScratch` whose initialized capacity is exactly the planned aligned channel size | The sum of all descriptor-sized arguments and alignment is checked against generated `MAX_TRANSFER_ALLOCATION_BYTES`; each syscall's public or implementation limit may be smaller. Every pointer descriptor is explicitly required or nullable, and every C string must terminate inside its remaining owned subrange | The host rejects negative, fractional, unsafe-integer, multiplication/addition/alignment overflow, positive null unless explicitly nullable, and a non-null `Deref` outer buffer without its length pointer. It captures every `Deref` length before planning. The fixed path passes `kernel_handle_channel` its exact 65,608-byte allocation; the widened path passes no host pointer or capacity to `kernel_transfer_channel_execute`, which derives both from the Reserved token. Rust verifies canonical pointer order, alignment, non-overlap, complete allocation bounds, descriptor nullability, bespoke layouts, and in-region C strings before dispatch | `#executeCapacityOwnedChannel` owns one rigid stage → execute → finish transaction. Callers receive neither an execute closure nor entry authority; all writes precede the one fixed/token execution and all readback is detached before lease revocation. Nested, promise-escaping, duplicate, omitted, or reordered execution is structurally unavailable | Node/browser; guest wasm32/64 independent of kernel width; kernel wasm32/64 | **Confirmed unsafe/uncertain domain edges.** Some raw pointers bypassed descriptors, fixed outputs such as `pipe(NULL)` were implicitly treated as nullable, `prctl` scalars were treated as pointers, `Deref` planning could reread mutable lengths, staging was not ownership-bearing, and Rust's bare-pointer scanner used `PATH_MAX` as both an allocation and semantic bound | **Capacity-safe in current source; final static-gate rerun pending.** Exact/capacity+1, positive-null and owned-empty, explicit-nullability drift, option-sensitive `prctl`, reordered/mutated `Deref`, bounded C strings, fixed/widened selection, reservation failure, and token settlement have focused coverage. Blocking-retry request and target ownership is independently complete as recorded in the checkpoint above; this capacity row does not substitute for that lifetime proof |
| `host/src/kernel-worker.ts::{#handleSyscallInner,completeChannel,handleBlockingRetry,handleSleepDelay}`; `PreparedChannelCompletion` | Output belongs to the just-completed fixed or widened scratch lease, but the only byte state allowed to outlive it is a detached `Uint8Array` plus its already-validated process destination | Exactly the output descriptors and successful byte counts are detached inline before lease release; error and interrupted completions publish no staged output | `completeChannel` has no scratch-read fallback. Timeout, stopped-process, signal, and teardown state accept only explicit detached writes; absent output means an empty list | Detachment occurs synchronously in the dispatch lease; later callbacks may overlap another scratch use without observing its bytes | Node/browser; guest/kernel wasm32/64 | **Confirmed scratch-lifetime defect.** Deferred completion could reread the shared allocation after another operation replaced it | **Safe in current source; validation pending.** Scratch-byte lifetime is complete here, while immutable request/target ownership is proved independently by the following retry row |
| `host/src/kernel-worker.ts::{#handleSyscallInner,handleBlockingRetry,#rememberBlockingRetrySnapshot,#replayBlockingRetrySnapshot,#releaseBlockingRetrySnapshot,#forgetBlockingRetrySnapshotAfterKernelLifecycle,#retrySyscallWithinKernelEntry,#retireExactChannelAsyncState}`; `crates/kernel/src/{blocked_retry.rs,syscalls.rs,wasm_api.rs}` | No scratch lease or Wasm view crosses the wait. For all seven snapshot shapes, the host owns detached immutable request state. Rust owns one opaque-token binding when its single authority maps the operation; zero records a host-only immutable snapshot | The represented scalar/vector/channel/message request, including its captured fd/mqd/qid, nested layouts, payload or output destinations, flags, priorities, and deadlines. The token is scoped to the exact pid, tid, and normalized operation and is never a substitute for allocation capacity | On first `EAGAIN`, Rust pins the stable one/two-OFD, MQ, or SysV target before control returns to JavaScript. The host then queries the positive token or authoritative zero and retains the first immutable snapshot only. Replays stage from that snapshot and activate the exact binding; they do not resolve a reused numeric name. Missing exports and negative, out-of-range, mismatched, or stale target-token results fail closed; zero is accepted only when Rust classifies the snapshot host-only. The union is exhaustive for blocking-dispatch replay | The snapshot/token may span promises, timers, and wake callbacks, but no live scratch view does. Terminal completion/cancellation/retirement releases the exact token. Exec, task exit, process exit, signal exit, and forced removal consume Rust pins first; only then does the host forget its snapshot without double release | Node/browser shared source; guest wasm32/64 and kernel wasm32/64 | **Confirmed adjacent request-identity defect, present independently of #1094.** Re-executing from live mailbox/process memory can redirect a blocked request without any scratch overflow | **Safe in current source; exact-head execution is not claimed here.** Focused regression targets cover all seven immutable replay shapes, token/zero classification, mismatch/failure, close-and-reuse, one/two-target bindings, and task/process lifecycle retirement |
| `crates/shared/src/process_layout.rs`; `crates/shared/src/host_abi.rs::SyscallArgSize::ProcessLayout`; `crates/kernel/src/process_wire.rs::{read_*,write_*}` | Main data capacity 65,536; exact width-selected native record is the capacity passed to Rust | `stack_t` 12/24, `mq_attr` 32/64, `statfs` 88/120, `sysinfo` 312/368, and `siginfo_t` 128/128 | Host selects by guest pointer width in private slot 5, validates the full caller range, and stages exactly that size; Rust rejects widths other than 4/8 and non-exact slices; output padding/reserved bytes are zeroed | One dispatch lease; Rust serializes into the complete lent slice before copy-back | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe mixed-width/native-layout contract.** Fixed wasm32 or partial records truncated wasm64/full native records; stale `sysinfo` syscall 208 conflicted with musl 269 | **Safe in current source; execution not claimed here.** C-layout, Rust boundary, and real-musl wasm32/wasm64 process-native fixtures are the required coverage targets |
| `host/src/kernel-worker.ts::dequeueSignalForDelivery`; `crates/kernel/src/wasm_api.rs::kernel_dequeue_signal`; `crates/kernel/src/process_wire.rs::{validate_signal_delivery_output,encode_signal_delivery_record}`; `libc/glue/channel_syscall.c` signal delivery | Rust main allocation; `KernelScratchLease.exportPointer(CH_SIG_BASE, 56)` lends exactly the generated 56-byte signal-delivery record and passes capacity 56 separately | Exactly one generated signal record: signum, handler, flags, raw eight-byte `si_value`, saved mask, `si_code`, two source-metadata words, and alternate-stack pointer/size | The host lease proves the owned allocation and current-memory range; Rust rejects null and any capacity other than 56 before writing. Rust first encodes all 56 bytes into an owned array, then publishes once. The host detaches all 56 bytes before releasing the lease and copies them to the process channel only after a nonnegative result | One synchronous lease per dequeue; the detached record is published only after the lease ends, so a wake or second channel cannot observe partially replaced scratch bytes. The C trampoline reconstructs a native `siginfo_t` and copies only the target-width `union sigval` bytes: four for wasm32 and eight for wasm64 | Node/browser; kernel wasm32/64 and guest wasm32/64 | **Weak capacity and metadata contract.** The old export accepted only a bare output pointer, and its 44-byte payload inside a 48-byte reserved channel area did not carry complete `si_value`, source metadata, or one authoritative delivery size | **Safe in current source; execution not claimed here.** Rust exact-capacity/serialization tests and the real-musl process-native fixture cover 56-byte delivery, `SA_SIGINFO`, sender metadata, and target-width C reconstruction on wasm32 and wasm64 |
| `host/src/kernel-worker.ts::drainMqueueNotification`; `crates/kernel/src/wasm_api.rs::{queue_mqueue_signal_notification,kernel_mq_drain_notification}`; `crates/kernel/src/mqueue.rs::mq_notify` | Rust main allocation; one leased pointer plus explicit capacity 8 for the wake-only `{ pid: u32, signo: u32 }` record. The full notification value remains in Rust's signal queue rather than this scratch record | At most one eight-byte wake record. `mq_notify(SIGEV_SIGNAL)` accepts only signums satisfying `1 <= signo < NSIG`; zero, `NSIG`, and a negative native value represented as `u32::MAX` are rejected before registration | The lease proves the owned allocation/current memory and Rust requires capacity 8 before writing. The host accepts only safe-integer results 0 or 1; a negative errno, fractional/unsafe value, or value above 1 fails closed before unchanged reusable bytes can be decoded. Rust queues raw eight-byte `si_value`, `SI_MESGQ`, sender PID, and UID before publishing the wake record | The eight bytes are detached inside one synchronous lease. The lease is released before wake/signal processing can reenter main scratch. A rejected registration does not occupy the queue's one-shot notification slot | Node/browser; kernel wasm32/64 and guest wasm32/64 | **Weak capacity and error contract.** The old drain export accepted a bare pointer, and a negative errno was truthy in JavaScript and could decode stale scratch as a fabricated notification; invalid signal registrations were not rejected before occupying the slot | **Safe in current source; execution not claimed here.** Native tests cover invalid signums without registration and a valid retry; the rebuilt process-native fixture covers `SI_MESGQ` plus full-width value/sender metadata, and the host regressions prove both fail-closed negative-result handling and the real export's null/7/8/9 boundary with exact eight-byte output canaries |
| `host/src/kernel-worker.ts::{#handleSyscallInner,#executeCapacityOwnedChannel}`; `crates/kernel/src/wasm_api.rs::kernel_mq_descriptor_msgsize`; `crates/kernel/src/mqueue.rs::{descriptor_msgsize,mq_timedsend,mq_timedreceive}` | Message, priority, and optional timeout records use the fixed main allocation when their complete aligned descriptor layout fits 65,608 bytes; a larger queue message uses one fresh token-bound `TransferScratch` with that exact complete capacity | The authoritative open queue's `mq_msgsize`, capped at `MAX_REPORTABLE_TRANSFER_BYTES`. Send must request no more than that value; receive must advertise at least it, but stages only `mq_msgsize` rather than allocating the caller's possibly larger capacity | Before any allocation write, the required descriptor query validates pid/tid/mqd and returns the queue limit. The host reports `EMSGSIZE` for send-above or receive-below that limit, captures all caller ranges, and routes the complete aligned plan through fixed/token capacity checks. Rust repeats descriptor/message-size checks and fallibly reserves message/vector storage before queue or notification mutation | Each attempt is one rigid synchronous stage → fixed/token execute → finish transaction and retains no scratch view. On first `EAGAIN`, the generic retry snapshot freezes the payload or output address, priority/timeout records, and deadline while Rust pins the exact mqueue descriptor. Replay uses that snapshot and token instead of reparsing a numeric mqd after close/reuse | Node/browser; guest wasm32/64; kernel wasm32/64 | **Confirmed atomic-message capacity defect.** Generic channel shortening could enqueue a prefix, return false `EMSGSIZE`, or make a configured large queue unusable | **Capacity, allocation-failure atomicity, and the represented MQ retry ownership are implemented in current source; exact-final-head validation remains pending.** Focused coverage exists for exact/+1 queue limits, fixed/widened selection, receive preflight, no prefix/no dequeue, allocation failure before mutation, sequential reservation reuse, and stable-target retry behavior |
| `crates/shared/src/host_abi.rs::SyscallArgSize::Fixed`; `crates/kernel/src/process_wire.rs::{write_stat,read_sched_param,write_sched_param}` | Main data capacity 65,536; the fixed native record size is part of the generated syscall descriptor | `stat` 112 bytes and `sched_param` 48 bytes on both supported caller widths | The descriptor proves the complete caller range and exact fixed capacity; these records do not use width selection or private slot 5 | One dispatch lease; Rust consumes or fills the complete fixed slice | Node/browser; guest wasm32/64 | **Confirmed partial-record contract.** Earlier descriptors did not name the complete musl object | **Implemented; validation pending.** Fixed-layout C drift checks and Rust exact/short tests |
| `crates/shared/src/host_abi.rs` `Getaddrinfo` descriptor; `host/src/kernel-worker.ts::_handleSyscallInner`; `host/src/kernel.ts::hostGetaddrinfo` | Main data allocation; output capacity exactly four bytes, matching musl's private syscall result | Input is a required NUL-terminated name; name plus four-byte output must fit 65,536; host backend result must be exactly/fewer than the lent four bytes | Full caller name and four-byte output ranges; descriptor capacity and current memory; Rust and host import both receive explicit four-byte capacity | One dispatch lease and synchronous host import; four detached bytes are copied back | Node/browser; guest/kernel wasm32/64 | **Confirmed live caller overwrite.** Fixed 256-byte copy-back wrote 252 bytes beyond musl's four-byte result object | **Implemented; validation pending.** Four-byte result plus 252-byte canary regression |
| `host/src/kernel-worker.ts::handleGetgroups`; `crates/kernel/src/wasm_api.rs::kernel_getgroups(size,list_ptr,list_capacity_bytes)` | Rust main allocation; positive request lends one explicit four-byte gid slot; count query lends pointer/capacity zero | Kandelo currently returns exactly one supplementary gid; `size` accepts 0 through `INT_MAX`, but positive size never increases the lent capacity beyond four | Positive caller output range is exactly four bytes; kernel pointer and capacity are staged together; Rust rejects null or capacity below four; returned count must be safe, `<= size`, and `<= 1` | One lease; output is detached before reuse; zero-count query performs no pointer conversion | Node/browser; guest/kernel wasm32/64 | **Confirmed unsafe.** A raw process pointer crossed into the kernel address space and Rust wrote one `u32` without an allocation-capacity contract | **Implemented; validation pending.** Capacity 0/3/4/5, null, count-query, and detached-copy regressions |
| `crates/shared/src/host_abi.rs` `Setgroups` descriptor; `host/src/kernel-worker.ts::_handleSyscallInner` | Rust main data allocation, exactly 65,536 bytes | Count times four bytes; maximum one-call source is 16,384 gids from `CH_DATA_SIZE / sizeof(gid_t)` | Checked integer multiplication, complete caller source, descriptor layout, allocation capacity, current memory; count zero ignores the caller pointer and resolves a checked non-null empty scratch address under the final lease | One dispatch lease; no scratch view survives | Node/browser; guest/kernel wasm32/64 | **Unsafe address-domain contract, not a demonstrated live overwrite.** Bare caller pointer could enter the kernel namespace; current Rust did not dereference it | **Implemented; validation pending.** 16,384/16,385, zero-count high pointer, and positive null regressions |
| `crates/shared/src/ioctl_contract.rs::IOCTL_REQUEST_CONTRACTS`; `host/src/kernel-worker.ts::_handleSyscallInner` ioctl branch; `crates/kernel/src/wasm_api.rs::kernel_ioctl` | Rust main data allocation; pointer requests receive exact request-specific capacity; scalar/no-argument/unknown requests receive no scratch pointer | Pointer sizes are table-selected: 1–160 bytes in the current table, including `termios` 60 and `DRM_IOCTL_VERSION` 36 for wasm32 or 64 for wasm64 | Unsigned request lookup; exact guest-width size/direction; complete caller range; null and one-byte-short rejection; explicit `buf_len`; Rust repeats kind, width, exact length, null, and current-memory checks. `ScalarI32` requests canonicalize only their low 32 transport bits, so unspecified upper wasm64 C-vararg bytes neither become a pointer nor reach Rust. Known width-incompatible pointer requests return `EOVERFLOW` | One dispatch lease; no pointer is manufactured for scalar/no-arg/unknown requests | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe/incorrect.** Generic 256-byte staging/copy-back overran small caller objects and scalar values were treated as pointers; width-specific DRM layout was not represented | **Implemented; generated/runtime validation pending.** FIONREAD four-byte canary, exact 4/36/64, short/null, every scalar request with signed/unsigned and dirty-high-bit inputs, no-arg/unknown, and unsupported-width regressions |
| `host/src/kernel-worker.ts::handleFcntlLock` | Rust main data allocation; 32-byte `struct flock` | Exactly 32 bytes | Full caller range, owned scratch range, current memory | One synchronous lease | Node/browser; guest/kernel wasm32/64 | Fixed size fit, bare pointer | **Implemented; validation pending** |
| `host/src/kernel-worker.ts::{handleSelect,handlePselect6}` | Rust main data allocation; three optional generated 128-byte fd sets plus timeout/mask records | Generated `FD_SETSIZE` 1,024 and `fd_set` size 128; optional eight-byte kernel mask and native timeout inputs | `nfds` is bounded by the generated set width; every optional fd set, timeout, outer pselect sigmask descriptor, and nested mask range is checked before staging | Each attempt is synchronous; retry owns copies/scalars and no scratch view | Node/browser; guest/kernel wasm32/64 | **Confirmed unsafe caller-range paths and duplicated layout constants** | **Safe in current source; execution not claimed here.** Select/pselect count/range boundaries use the generated contract |
| `host/src/kernel-worker.ts` generic `ppoll` descriptor planning and retry conversion | Main allocation/channel; 16-byte caller timespec and optional eight-byte signal mask become scalar kernel arguments | Fixed native records from syscall contract | Raw pointers remain bigint until lossless conversion; both complete caller ranges are proved on the first attempt and retry | Only final dispatch lease contains scratch bytes; retry retains scalars, never a view | Node/browser; guest wasm32/64 | **Unsafe/uncertain.** Special pointers were outside generated descriptors | **Implemented; validation pending.** Out-of-range and unrepresentable wasm64 regressions |
| `host/src/kernel-worker.ts::{handleEpollCtl,handleEpollPwait}`; `crates/shared/src/lib.rs::WasmEpollEvent` | Caller process memory for events plus main scratch for the internal poll request; native epoll event is exactly 16 bytes | One `epoll_ctl` event or checked `maxevents * 16`; fields are events at offset 0, zero/ignored pad at 4–7, data at offset 8 | Checked multiplication and complete caller input/output ranges; exact 16-byte records; copy-out explicitly zeroes padding and writes `u64` data at offset 8 | One synchronous attempt; retry/interest state stores values, not process or scratch views | Node/browser; guest wasm32/64 | **Confirmed unsafe caller/output range handling and stale 12-byte assumption** | **Implemented; validation pending.** Exact-end, one-byte-short, padding, and offset-eight regressions |
| `host/src/kernel-worker.ts::{checkedProcessIovecs,copyFlattenedTransferInput,handleWritev,executeMainScratchTransfer,executeReservedScratchTransfer}`; `crates/kernel/src/transfer.rs`; `crates/kernel/src/wasm_api.rs::kernel_transfer_io_execute` | At most 65,536 bytes use the Rust-owned main data allocation; larger vectors receive one fresh Rust-owned initialized `Vec<u8>` whose pointer and capacity exist only under a positive reservation token | Count 0..generated `IOV_MAX` (1,024); the complete aggregate is checked against `SSIZE_MAX`/the transfer export's `i32` result domain before either allocation is written | Native tables are 8 bytes/entry on wasm32 or 16 on wasm64; the complete table and every nested source range are checked losslessly before begin. Payload is flattened without a second kernel table, the host proves requested bytes against explicit allocation capacity and current memory, Rust repeats token/length/capacity checks, and the returned count cannot exceed the aggregate. Caller address zero is valid only when the complete caller-owned range fits; a zero-length entry performs no access | Exactly one lease and one scalar kernel write per logical vector. The large token moves Reserved→Executing before the scratch mutex is released across the host call, then Ready→cancelled on an ordinary result. Void ingress is queued in arrival order until the outer export and lease unwind; result-bearing reverse entry fails rather than fabricating a syscall errno. A host-import trap leaves the token Executing and fail-stops the worker rather than reusing uncertain bytes | Node/browser; guest wasm32/64; kernel wasm32/64 | **Confirmed live allocation overflow plus operation-boundary and offset defects.** Old fast admission omitted per-entry padding and could write 3,072 bytes past the 65,536-byte data area; the slow path split one vector and rounded `pwritev` offsets above `Number.MAX_SAFE_INTEGER` | **Safe in current source; execution not claimed here.** Coverage targets include exact/capacity+1, `IOV_MAX+1`, later-invalid nested range before begin, allocation failure, invalid reservation range, sequential/reentrant/trap paths, exact `2^53+1`, native one-operation tests, and a real 65,538-byte AF_UNIX datagram in Node and Chromium |
| `host/src/kernel-worker.ts::{checkedProcessIovecs,copyFlattenedTransferOutput,handleReadv,executeMainScratchTransfer,executeReservedScratchTransfer}`; `crates/kernel/src/transfer.rs`; `crates/kernel/src/wasm_api.rs::kernel_transfer_io_execute` | At most 65,536 bytes use the main data allocation; larger vectors use one fresh token-bound Rust `Vec<u8>` with explicit capacity | Count 0..1,024; the complete aggregate must stay in the one-operation transfer/result domain | The complete native table and every caller destination are proved before begin. Rust receives one contiguous capacity-bounded destination; the host validates the producer count, then scatters only that prefix through checked caller capacities. EOF and short results complete the one operation without issuing another read. Exact positioned offsets remain `bigint` through dispatch | One main lease or one Reserved→Executing→Ready large token; output is published only while the matching lease is live. A retry retains no view; reentry and traps follow the same fail-closed rules as writes | Node/browser; guest wasm32/64; kernel wasm32/64 | **Confirmed live allocation overwrite plus operation-boundary and offset defects.** Old fast admission omitted 8,184 bytes of table footprint and lacked `IOV_MAX`; the slow path could combine a second blocking read after EOF/short result and rounded `preadv` offsets | **Safe in current source; execution not claimed here.** Coverage targets include full table/count/range boundaries, producer over-report, sequential/interleaved guards, exact `2^53+1`, native one-call/EOF/record tests, and the real cross-channel AF_UNIX datagram read |
| `host/src/kernel-worker.ts::{handleLargeWrite,handleLargeRead,handleFlattenedTransfer,executeReservedScratchTransfer}`; `crates/kernel/src/transfer.rs` | One fresh Rust-owned tokenized allocation sized for the complete scalar request, not repeated main-scratch chunks | Complete caller range, bounded by the transfer result domain; begin fails with `ENOMEM` before publishing authority if reserve fails | Caller range is proved before begin; reservation exposes pointer plus actual capacity; the host checks allocation capacity and current memory; Rust rejects length above capacity; host and Rust both reject a returned count above the request | Exactly one scalar kernel operation. The mutex is not held across the host callback, but the Executing state excludes replacement. Normal return cancels and drops the allocation; trap fail-stops without cancel | Node/browser; guest/kernel wasm32/64 | **Confirmed caller-range weakness and semantic split.** The old implementation used safe-sized chunks but made one user operation into several kernel/host operations | **Safe in current source; execution not claimed here.** Coverage targets include the complete caller range, capacity/capacity+1, allocation failure, invalid range, and sequential/reentrant/trap behavior |
| `host/src/kernel-worker.ts::{handleWritev,handleReadv,handleLargeWrite,handleLargeRead,handleSharedMappingsAfterFileSyscall}`; `crates/kernel/src/{process.rs,syscalls.rs,wasm_api.rs}`; `host/src/{kernel.ts,file-offset.ts,types.ts}` ordinary and large `pread`/`pwrite` families | Main or tokenized transfer allocation; the signed-i64 position is a scalar `bigint`; a Rust-lent read destination is staged in host memory before one checked publish | One complete scalar/vector operation; backend offset range is signed i64, while a number-only backend has an explicit exact-representation boundary | Offset words reconstruct directly to `bigint`; Rust calls required `host_pread`/`host_pwrite` imports rather than seek/read-or-write/restore; `PlatformIO` carries `number | bigint`; unsafe narrowing returns `EOVERFLOW`. Read producer counts and Rust-lent destinations are capacity-checked. Shared-mapping updates use the exact offset only when safely indexable, otherwise refresh from authoritative storage | One positioned backend operation does not mutate the shared OFD cursor. Staged read bytes do not lend a live kernel view to the backend; main/token lifetime rules remain unchanged | Node/browser; guest wasm32/64; kernel wasm32/64 | **Confirmed precision and atomicity defects adjacent to scratch dispatch.** Ordinary/large offsets rounded `2^53+1`, shared-map follow-up could alias a rounded page, and seek/restore raced shared OFDs and could fail to restore after I/O error | **Safe in current source; execution not claimed here.** Coverage targets include exact signed-i64 words above `2^53`, unchanged cursor, one host call, backend `EOVERFLOW`, wasm32/64 import ranges, and producer over-report |
| `crates/kernel/src/syscalls.rs::{sys_write,validate_append_outcome,transfer_output_plan,stage_transfer_input,commit_staged_transfer_input}`; `host/src/kernel.ts::{#hostAppend,#hostAppendPosition}`; `host/src/vfs/{memory-fs,sharedfs-vendor,opfs,opfs-worker,host-fs,default-mounts-node}.ts`; `host/src/platform/node.ts` | Rust owns the regular-file OFD flag/cursor; each backing owns EOF and mutation. The import source is a Rust-lent, capacity-checked kernel range for one call, while the paired result is a scalar `{ written, end }` consumed through a one-shot latch | One complete scalar/vector write within the active main/tokenized transfer capacity; optional file-size ceiling is exact signed i64. Externally mutable native backings accept no append payload | Rust independently validates pointer/length, returned count, derived start/end, signed-i64 conversion, and the file-size ceiling. Shared memory holds EOF/limit/write under the inode lock; OPFS uses one serialized handler. A module-private identity brand is granted only to the lifecycle-owned Node scratch backing; externally mutable HostFS and raw Node backings return `EOPNOTSUPP` before mutation. For `sendfile`/`copy_file_range`/`splice`, regular input uses positioned read and a kernel pipe uses peek; only the append-reported prefix commits source state | The kernel export gate admits one result-bearing operation. The append-position latch is cleared before every attempt and bound to handle/count. A malformed outcome after possible mutation traps and poisons the generation. Two sequential/interleaved managed operations cannot replace each other's result; source staging owns no scratch view after return | Node/browser; guest wasm32/64; kernel wasm32/64 | **Confirmed adjacent ownership/atomicity defects.** Seek-to-end plus write did not return the authoritative ending position or combine `RLIMIT_FSIZE` with mutation. transfer wrappers could consume input before append rejected or clipped it | **Safe in current source; execution not claimed here.** Coverage targets include managed exact/limit/interleaving behavior, fail-closed malformed outcomes, prefix-only transfer commit on rejection/short/limit/stale-fstat cases |
| `crates/kernel/src/wasm_api.rs::{channel_readv,channel_writev,channel_preadv,channel_pwritev,checked_kernel_iovec_entries}`; `libc/glue/{channel_syscall.c,syscall_glue.c,syscall_imports.h}`; `host/src/worker-main.ts::assertSupportedKernelFunctionImports` | Private channel helpers receive `ChannelScratchRegion { start, capacity }`; there is no host-callable bare vector pointer | Canonical channel allocation and generated `IOV_MAX`; current programs use `channel_syscall.c` | Table and every payload range are checked against the same allocation-bearing region. The four raw vector exports/declarations are absent from the source and ABI snapshot. Unknown `kernel.*` function imports fail before process instantiation; they are never replaced with zero-success stubs | Private synchronous channel dispatch only; no compatibility caller can overlap an unowned raw pointer | Node/browser; kernel wasm32/64; guest wasm32/64 through channel IPC | **Confirmed unprovable compatibility surface.** The removed signatures checked total kernel memory but carried no allocation capacity; historical direct glue passed process-memory native iovecs into a distinct kernel address space/layout | **Safe in current source; execution not claimed here.** Required targets are the static source/snapshot guard, callable-import admission tests, and declared-shell artifact scan |
| `host/src/kernel-worker.ts::{checkedProcessMessage,nativeControlToKernelWire,kernelMessageLayout,handleSendmsg,#executeCapacityOwnedChannel}`; `crates/kernel/src/socket_wire.rs`; fixed `Kernel{Msghdr,Iovec,Cmsghdr}Wire` | The complete aligned canonical message uses main scratch when it fits 65,608 bytes and a fresh token-bound `TransferScratch` when larger. Both contain one 28-byte kernel header, optional name/control, zero or one eight-byte canonical iovec, and the flattened payload | Caller-native `msghdr` is generated as 28 bytes on wasm32 or 56 on wasm64; native iovec count is 0..generated `IOV_MAX` 1,024; aggregate payload is bounded by `MAX_REPORTABLE_TRANSFER_BYTES`, control conversion retains its explicit protocol bound, and the complete aligned allocation must fit `MAX_TRANSFER_ALLOCATION_BYTES` | Full native header/table and every nested source range are checked losslessly before reservation. Native `cmsghdr` records are validated and translated to the generated 12-byte-header/alignment-4 wire; all caller iovecs are flattened into one owned payload. The fixed path proves 65,608-byte capacity; the widened token path derives pointer/capacity in Rust. Rust revalidates the complete canonical ancillary stream and zero/one-iovec wire, and the returned count cannot exceed staged payload | One rigid stage → fixed/token execute → finish lease covers header/control/flatten/call. Only detached parsed metadata exists before it and no scratch view survives. On `EAGAIN`, `SendmsgBlockingRetrySnapshot` retains the checked message/layout plus detached name, control, and payload. Rust pins the carrier OFD and its frozen in-flight ancillary descriptor template; replay uses the same token even if the numeric fd is closed and reused | Node/browser; guest wasm32/64; kernel wasm32/64 | **Confirmed live allocation overflow plus mixed-width protocol defect.** Count/layout capacity was incomplete, only the first caller iovec reached Rust, and wasm64 ancillary headers were interpreted as wasm32 | **Synchronous transfer capacity and the represented `sendmsg` retry ownership are implemented in current source; exact-final-head static and runtime validation remain pending.** `IOV_MAX+1`, exact/capacity+1, fixed/widened selection, multi-iovec/zero-entry flattening, malformed control, invalid descriptors, sequential exclusion, wasm32/64 wire translation, immutable replay, and carrier close/reuse have focused coverage |
| `host/src/kernel-worker.ts::{checkedProcessMessage,kernelControlCapacityForRecv,kernelControlToNative,kernelMessageLayout,handleRecvmsg,#executeCapacityOwnedChannel}`; `crates/kernel/src/wasm_api.rs::kernel_recvmsg` | The same canonical layout uses the fixed main allocation when its aligned total fits and one token-bound `TransferScratch` otherwise; caller name, native control, and every native iovec destination retain separate checked process-memory capacities | Native header 28/56; count 0..1,024; aggregate destination capacity is bounded by `MAX_REPORTABLE_TRANSFER_BYTES`; canonical ancillary capacity is derived from what the caller-native control layout can represent; the complete aligned allocation must fit `MAX_TRANSFER_ALLOCATION_BYTES` | Complete caller table/destination ranges are proved before reservation. The fixed or token-owned region holds one contiguous receive payload plus name/control. Returned wire length, alignment, type, descriptor width, and producer byte count are validated before expansion; the host detaches and scatters only the bounded prefix across all caller iovecs. `MSG_TRUNC` may report the full datagram while only that prefix is copied | One rigid stage → fixed/token execute → finish lease snapshots all output, and caller publication uses detached arrays after release. Error paths publish nothing. On `EAGAIN`, `RecvmsgBlockingRetrySnapshot` retains the checked native header, iovec/name/control destinations, canonical layout, flags, and capacities. Rust pins the exact carrier OFD. Replay never reparses a replacement msghdr or numeric fd, and detached output publishes only to the originally validated destinations | Node/browser; guest wasm32/64; kernel wasm32/64 | **Confirmed live allocation overwrite plus mixed-width/first-iovec defects.** Complete count/footprint was unproven, only one destination received bytes, and wasm64 `cmsghdr` capacity could install descriptors that could not be represented on copy-back | **Synchronous transfer capacity and the represented `recvmsg` retry ownership are implemented in current source; exact-final-head static and runtime validation remain pending.** Exact/capacity+1, fixed/widened selection, multi-iovec scatter with a zero middle entry, EAGAIN/no-publish, malformed output, `MSG_CTRUNC`, flags, padding, wasm32/64 matrices, immutable destination replay, and carrier close/reuse have focused coverage |
| `crates/kernel/src/syscalls.rs::{sockaddr_family,checked_sockaddr_un_path,parse_sockaddr_in,parse_sockaddr_in6,sys_bind,sys_connect,sys_sendto}` | The already capacity-bounded channel input remains one immutable address object until the syscall returns; socket/VFS/registry/HostIO state are separate authoritative owners | A complete admitted `sockaddr_storage` at most 128 bytes, with the family-specific concrete parser applying the narrower minimum/maximum | The parser validates the embedded family before reading family-specific path/address fields. Rejection precedes ephemeral-port allocation, VFS creation or lookup, AF_UNIX registry lookup, `HostIO` network dispatch, and socket state changes | One synchronous Rust dispatch; failure publishes no external effect and the same descriptor remains usable by a following matching-family control | Node/browser shared kernel; guest/kernel wasm32/64 | **Confirmed unsafe adjacent state mutation, independently present at the audited base.** Wrong-family bytes could reach address/path interpretation before the discriminator was proved, allowing bind/connect/sendto to mutate or dispatch using the wrong address model | **Safe in current source; exact-final-head execution pending.** The five named Rust regressions cover AF_INET and AF_UNIX bind/connect/sendto wrong-family rejection, unchanged socket/port/VFS/registry/host-call state, and matching-family controls |
| `host/src/kernel-worker.ts::{handleSpawn,decodeSpawnBlobStrings,handleSpawnAfterResolve,beginLargeSpawnScratch,cancelLargeSpawnScratch}`; `crates/kernel/src/spawn.rs::{SpawnScratchBuffer,measure_strings_by_offset,decode_measured_strings}`; `crates/kernel/src/wasm_api.rs::kernel_spawn_reserved_process` | Ordinary blob uses main allocation; large blob uses token-bound Rust `Vec<u8>` whose pointer and actual capacity are returned only while reserved | Complete blob at most generated 8,417,320; argv/environment representation at most 4 MiB; path/action/count caps from generated contracts | Caller ranges, parsed counts, paths, complete blob length, allocation capacity, current memory, pointer width, token, and reservation state are independent checks. Host and Rust first measure every referenced string against one aggregate budget, then allocate/decode | Async lookup owns a JS copy; begin/copy/commit have no await. Begin and pointer/capacity queries fail without waiting on contention. After every successful begin, cancellation runs in `finally`, including setup/copy failure. Commit and cancellation wait on the same no-host-import mutex and return only after the token is consumed, released, or shown stale; host/Rust guards reject overlap. Duplicate maximum-count offsets cannot amplify allocations before rejection | Node/browser; guest/kernel wasm32/64 | #1094 spawn fix was capacity-safe but retained a fixed 8,417,320-byte region after first large use; decoding still admitted allocation amplification from duplicate offsets | **Safe in current source; execution and sizing measurements are not claimed here.** Coverage targets include the growable Rust-owned reservation, pre-allocation aggregate accounting, and exact-count/`ARG_MAX` boundaries |
| `host/src/kernel-worker.ts::{runSharedMappingHostOperation,populateMmapFromFile,pwriteFromProcessMemory,readSysvShmRange,writeSysvShmRange}`; `KernelEntryGate::{runSerializedHostOperation,KernelVoidIngressScope.invokeSerializedHostOperation}` | Main data allocation for transit, 65,536 bytes per chunk; mapped/shared bytes have separate owners | One `CH_DATA_SIZE` chunk; overall mapping/segment size comes from checked mapping/kernel state | Complete process/mapping range and each Rust producer/consumer count; transit lease separately proves scratch capacity/current memory. Each synchronous backing read/write holds either the exact active entry's host-operation marker or the gate-owned host-only marker; it returns no Promise/thenable or retained backend view | One synchronous lease per chunk; authoritative shared bytes/snapshots live outside scratch. Reentrant void ingress queues, result-bearing ingress and a second host operation reject, and host-only teardown can run only while the gate is otherwise idle | Node/browser; guest/kernel wasm32/64 | **Confirmed ownership/overlap gap.** Capacity fit, but a bare scratch pointer and an unscoped synchronous backend callback could overlap or reenter the operation that was validating and committing its staged result | **Safe in current source; exact-final-head validation pending.** Allocation-bearing transit plus scoped/host-only serialization is covered by gate tests and shared-mapping inheritance regressions, including a hostile synchronous backend callback |
| `host/src/kernel-worker.ts::{handleIpcShmat,handleIpcShmdt}` | Process `Memory` mapping and host `SysvShmMapping.snapshot`, not kernel scratch; address key is the checked native guest pointer | Segment size returned by the kernel attachment operation; full mapped range must fit process memory | Raw bigint address is checked losslessly for guest width before attachment/map lookup; mmap result and full mapped range are checked; failure rolls back attachment; shmdt uses the exact checked key | Coherence/attach/detach steps are synchronous; snapshot owns bytes between boundaries; no kernel scratch view is retained | Node/browser; guest wasm32/64 | **Confirmed high-address alias defect.** `>>> 0` narrowed wasm64 hints/detach keys so an address above 4 GiB could alias a low mapping | **Implemented; validation pending.** High hint, unsafe integer, and non-aliasing detach regressions |
| `host/src/kernel-worker.ts::handleSysvMessage`; `crates/shared/src/lib.rs::platform_limits::SYSV_MSG_MAX_BYTES`; `crates/kernel/src/{blocked_retry.rs,ipc.rs,ipc_wire.rs}` | The fixed main data allocation holds one generated eight-byte kernel mtype header plus payload; caller storage begins with a native four-byte wasm32 or eight-byte wasm64 `long`. The generated 8,192-byte payload ceiling keeps the complete canonical record below fixed capacity, so this path deliberately does not reserve widened transfer scratch | At most generated `SYSV_MSG_MAX_BYTES` (8,192) of message text. A larger send is `EINVAL`; receive may advertise a larger caller capacity, but no dequeued payload can exceed the queue contract | The host proves native prefix plus requested caller range and checked header addition before staging; Rust accepts only the shared payload maximum, converts through the fixed i64 wire, and fallibly reserves payload/deque storage before queue mutation. On `MSG_NOERROR`, byte accounting releases the complete dequeued message even when only a prefix is copied | One synchronous fixed-region lease and detached output. On `EAGAIN`, `SysvMessageBlockingRetrySnapshot` retains caller width, original destination, message size and flags, detached send input/native type, or receive type selector. Rust pins the exact System V message queue. Replay uses the snapshot/token rather than reparsing msgbuf or resolving a reused qid | Node/browser; guest wasm32/64; kernel wasm32/64 | **Unsafe mixed-width/native-long and aggregate-capacity contract.** The old path also had no explicit cross-layer message ceiling or allocation-failure atomicity | **Synchronous fixed-capacity transfer and represented System V message retry ownership are implemented in current source; exact-final-head validation remains pending.** Exact 8,192/8,193, wasm32/64 native mtype, allocation failure before mutation, `MSG_NOERROR` truncation, full-byte queue accounting, immutable replay, and qid close/remove-reuse behavior have focused coverage |
| `host/src/kernel-worker.ts::handleIpcControl`; `crates/kernel/src/wasm_api.rs::{kernel_msqid_ds_bytes,kernel_shmid_ds_bytes}`; `crates/kernel/src/ipc_wire.rs::{read_*,write_*}` | Main data allocation; `msqid_ds` 96/120 and `shmid_ds` 88/112 for wasm32/64 | Exact layout size returned by required Rust query for `IPC_SET`/`IPC_STAT`; pointerless commands stage zero bytes | Width query, command direction, full caller range, allocation capacity, exact Rust slice, and narrowing checks; no fixed fallback | One synchronous lease; outputs serialize completely before copy-back | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe mixed-width contract.** Fixed wasm32 descriptors proved/staged the wrong LP64 ranges | **Implemented; validation pending.** Exact/short/null/unsupported-width tests |
| `host/src/kernel-worker.ts::handleSemctl`; `crates/kernel/src/wasm_api.rs::{kernel_semid_ds_bytes,kernel_semctl_array_bytes}`; `crates/kernel/src/ipc_wire.rs::write_semid_ds` | Main data allocation; `semid_ds` 72/88 or exact `2 * sem_nsems` array bytes | Rust permission-aware query is authoritative for GETALL/SETALL; structure query is authoritative for IPC commands | PID/TID, command kind, guest width, exact length, caller range, allocation capacity, and Rust slice bounds; missing/invalid required query fails closed | One synchronous lease; no `IPC_STAT` compatibility call is used to infer writable array capacity | Node/browser; guest wasm32/64 | **Confirmed unsafe.** Host assumed 1,024 array bytes and wasm32-only 72-byte structure | **Implemented; validation pending.** Exact/capacity+1, permissions, and missing-export regressions |
| `host/src/kernel-worker.ts::#requireTcpScratchRegion` data paths | Separate Rust allocation; runtime-private `#tcpScratchRegion`, 65,536 bytes | One producer-checked chunk at most 65,536 bytes | Source/backend length, region capacity/current memory, and Rust producer count | Each callback/worker message enters one synchronous lease and detaches output before returning | Node/browser; kernel wasm32/64 | Sizes fit, but pointer escaped ownership value | **Implemented; validation pending.** Runtime-private capacity-bearing region |
| `host/src/kernel.ts` public socket/poll/terminal/ioctl/uname/pipe/rusage/select methods | Separate Rust allocation; runtime-private `#apiScratchRegion`, 65,536 bytes | Call-specific exact fixed record or bounded payload; public poll accepts exactly `capacity / generated sizeof(pollfd)` = 8,192 entries and select uses generated 1,024-bit sets | Lease proves allocation and current memory; call validates the complete caller/result length and derives aggregate limits from the actual owned capacity rather than an unrelated protocol count | One synchronous public call; nested use fails | Node/browser; kernel wasm32/64 | **Confirmed unsafe ownership and artificial poll cap.** Temporary addresses 4 and 16 named no Rust allocation, while public poll reused `IOV_MAX` instead of its allocation capacity | **Safe in current source; execution not claimed here.** Allocator-owned public scratch, poll exact-capacity/capacity+1, generated select layout, and no reflective region access |
| `host/src/kernel.ts::WasmPosixKernel.setsockopt`; `host/src/kernel-scratch.ts::{KERNEL_SCRATCH_EXPORT_NAMES,kernelScratchRequiredPointerArguments}`; `crates/kernel/src/wasm_api.rs::kernel_setsockopt` | The runtime-private allocator-owned API region; the lease lends an exact four-byte subrange and its derived wasm32/wasm64 pointer | Exactly one JavaScript scalar option value encoded as little-endian `u32` | The lease writes only the four-byte allocation subrange, proves current-memory bounds and pointer width, and invokes the existing five-argument export with `{ optval_ptr, optlen: 4 }`. The scratch contract classifies argument 3 as required, while the compiler audit defaults every generated kernel export to denied even if it is absent from the narrower runtime scratch list | One synchronous lease and one Rust call; nested public scratch use rejects and no pointer/view escapes | Node/browser shared wrapper; kernel wasm32/64 | **Confirmed live ownership/signature defect found by the widened audit.** The direct public wrapper passed only four arguments, treated the scalar `value` as `optval_ptr`, omitted `optlen`, and was absent from the scratch export list; rejection therefore occurred only after unowned address authority crossed the boundary | **Safe in current source; exact-head execution not claimed here.** Focused wasm32/wasm64 coverage targets the exact pointer type, four staged bytes, low-memory and post-capacity canaries, five-argument call, and generated-export default-deny regression |
| `host/src/kernel.ts::{#hostRead,#readKernelBytes,#writeKernelBytes}` and VFS (`stat`, `statfs`, `pathconf`, `readlink`, `readdir`), clock, random, waitpid, network/getaddrinfo, GL, proc, and KMS import callers | Rust-owned slice/local/struct lent as pointer plus explicit capacity for one import; `host_kms_mode_info` instead derives its exact 68-byte capacity from generated `WpkDrmModeModeinfo`; producer backends receive host-owned staging buffers rather than a live kernel view | Genuine intrinsic backend span no larger than the Rust-supplied or generated capacity; fixed formats use their exact generated/Rust size | Raw signed wasm32 or bigint wasm64 import pointer is normalized losslessly; nonnegative safe length, complete current-memory range, detached/staged producer data, and producer count precede one `#writeKernelBytes` publish; no typed-array clamping or subclass getter counts as validation | Synchronous import only; neither backend nor callback receives a kernel-memory view | Node/browser; kernel wasm32/64 | Correct owner but incomplete conversions/result checks and live-view lending | **Implemented; validation pending.** Checked Rust-lent range plus host staging; high-bit wasm32 KMS and hostile-producer regressions; raw sink is explicitly allowlisted below |
| `apps/browser-demos/test/fixtures/opfs-advisory-lock-client-worker.ts::issue`; `apps/browser-demos/test/epoll-repro.ts::main` | Test kernel allocations represented as `KernelScratchRegion`; one complete channel | Fixed diagnostic channel and event records | Same lease capacity/current-memory rules as production | One lease covers stage/dispatch/snapshot | OPFS: real Chromium wasm32; epoll diagnostic: Node wasm32 | Sizes fit, bare diagnostic pointers/views | **Safe in current source; browser execution is not claimed here.** The static contract includes both selected diagnostic sources; their exact-head runtime checks remain external validation targets |
| `host/src/worker-main.ts::{encodeStartupMetadata,buildKernelImports}`; `libc/musl-overlay/crt/crt1.c::{_start,add_startup_entry_length}`; `crates/kernel/src/wasm_api.rs::{kernel_argv_read,kernel_environ_get}` | The guest process owns an exact-lifetime anonymous `mmap` containing the native-width argv/env pointer table and strings. The CRT's fixed 32 KiB length table retains only query metadata until the mapping is complete. Neither region is kernel allocator scratch | Generated maxima of 4,096 argv entries, 4,096 environment entries, and 65,536 encoded bytes per entry; the complete strings, NULs, native-width pointers, and two terminators must fit generated `ARG_MAX` (4 MiB) | The host encodes one immutable launch snapshot. A zero-capacity import queries its exact length; a positive short capacity returns `ERANGE` without writing; an exact copy proves an integer capacity, a lossless wasm32/wasm64 pointer, and the complete current guest-memory range. The CRT retains the first lengths across `mmap`, passes each exact capacity, and traps before publication on allocation failure, error, count mismatch, or aggregate drift | Imports copy synchronously from the immutable snapshot. The CRT publishes no `argv`/`envp` pointer until every query, allocation, exact copy, and terminator has succeeded; the mapping then lives for the complete libc lifetime | Node/browser shared worker source; guest wasm32/64. Focused host tests exercise both widths; the real CRT is compiled for both widths and a native harness executes allocation-failure and query/copy-mismatch branches | **Confirmed unsafe at the audited base.** `Math.min` silently prefix-copied into undersized destinations, unchecked `Number(bigint)` could lose a wasm64 pointer, and CRT-local 1,024-entry plus 64/128 KiB buffers truncated otherwise admitted metadata | **Safe in focused source validation; final end-to-end candidate validation pending.** Exact/capacity+1, invalid pointers and lengths, memory-end boundaries, exact/oversized `ARG_MAX`, entry/count ceilings, immutable sequential/interleaved reads, allocation failure, and retry mismatch have executable regressions |
| `host/src/process-memory.ts::createProcessMemory`; `host/src/kernel-worker.ts::CentralizedKernelWorker.registerProcess`; `host/src/{node,browser}-kernel-worker-entry.ts` clone/transport, excluding the separately inventoried startup imports above | Each process owns its own `WebAssembly.Memory`; worker transport owns detached `ArrayBuffer`/`SharedArrayBuffer` values. None is the kernel `Memory` or a pointer returned by `kernel_alloc_scratch` | Process layout, guest address-space, and worker-protocol limits | Guest-width range checks and transport-specific validation; `registerProcess` rejects object identity with the active kernel `Memory` before any export or channel publication; the static audit seeds these exact constructors/messages as `process-memory`, never as allocator scratch | Process/worker generation lifetime; asynchronous transport may retain its own detached/shared process backing but no kernel-scratch view | Node/browser; guest wasm32/64 | Outside allocator model | **Reviewed process-memory exclusion; final transport tests pending.** Its separate owner is explicit and executable rather than hidden under a generic raw-memory allowance; focused registration coverage proves the kernel-memory identity rejection has no export side effect |
| `host/src/framebuffer/registry.ts::{FramebufferRegistry,FbBinding.hostBuffer}` and browser framebuffer binding/rebinding messages | An mmap framebuffer view belongs to one process `Memory`; a write-based framebuffer owns a host `ArrayBuffer`/`Uint8ClampedArray` sized from checked geometry. Neither backing is kernel scratch | Binding `addr/len` or `height * stride`, plus framebuffer/device format limits | Registry binding and process-range/geometry checks select the exact backing; memory growth invalidates cached process views. Static seeds classify only these exact values as `framebuffer` | Mapping/binding lifetime and renderer callbacks may be asynchronous. Cached views are dropped on grow/unbind/teardown, and no allocator-scratch lease enters the registry | Browser presentation plus shared Node/browser host code; guest wasm32/64 | Outside allocator model | **Reviewed framebuffer exclusion, not a scratch-safety claim.** Framebuffer runtime and teardown coverage remains subsystem-specific |
| `host/src/dri/registry.ts::{GbmBoRegistry,InternalEntry.sab}` and DRI/GBM bind/unbind synchronization | Each buffer object owns an explicit host `SharedArrayBuffer`; per-process mmap ranges belong to their respective process memories | Kernel-reported buffer-object size and each checked binding `addr/len` | The registry validates object/binding identity and copies only between the buffer object's canonical SAB and checked process ranges. Static seeds classify the SAB separately from both kernel and process memory | Buffer-object reference/binding lifetime; synchronization occurs at bind/unbind boundaries and may span processes, but never retains allocator scratch | Node/browser shared host path; guest wasm32/64 | Outside allocator model | **Reviewed explicit shared-backing exclusion.** Coherence is the DRI registry's snapshot contract, not a kernel-scratch lease |
| `host/src/kernel-worker.ts::{populateMmapFromFile,pwriteFromProcessMemory,readSysvShmRange,writeSysvShmRange}` mapped-file and System V shared-memory backings | Authoritative VFS storage, process mappings, and `SysvShmMapping.snapshot`/shared backing own the durable bytes; main scratch is only the separately inventoried 65,536-byte transit chunk | Checked mapping/segment size, processed in bounded transit chunks | Mapping/process ranges and backing lengths are proved independently; each transit chunk uses its own main-scratch lease under the serialized host-operation contract | Backing/mapping lifetime may outlive a transit call. No scratch view survives a chunk or becomes the authoritative mapped/shared state | Node/browser; guest/kernel wasm32/64 | Outside allocator model except for the already reviewed transit lease | **Reviewed mapped/shared-backing exclusion.** Ownership is explicit; mapping coherence and serialization retain their own runtime validation |

## Explicit write sinks and raw-write allowlist

All allocator-owned bulk transfers and scalar channel writes converge on the
following sinks. `KernelScratchDataView` is a guarded part of the abstraction,
not an allowance for a caller-created native `DataView`.
`KernelScratchLease.copyFrom` and `fill` are likewise abstraction-internal
guarded sinks. The only raw variable-size kernel-memory write outside that
abstraction is `WasmPosixKernel.#writeKernelBytes`, whose pointer and capacity
are lent by Rust for one synchronous host import. All variable-size
allocator-owned syscall staging must call `KernelScratchLease`. The other
allowlisted occurrences in `host/test/kernel-scratch-contract.test.ts` are
private core getters/stores/factories, read-only views, revocable checked
views, allocator/reservation control calls, or atomic futex control; none
authorizes a call-site raw write.

| Exact write sink | Destination owner and capacity proof | Source/result proof | Lifetime / disposition |
|---|---|---|---|
| `host/src/kernel-scratch.ts::KernelScratchDataView::{setBigInt64,setBigUint64,setFloat32,setFloat64,setInt8,setInt16,setInt32,setUint8,setUint16,setUint32}` | The native `DataView` is private and spans only the range proved by `KernelScratchLease.dataView`; a `Memory.buffer` replacement triggers the full proof again | Native `DataView` bounds-checks each scalar width and offset inside that exact range | Every setter calls `currentView`, which rechecks the active lease; **guarded scratch-core sink, not a raw allowance** |
| `host/src/kernel-scratch.ts::KernelScratchLease.copyFrom` — `Uint8Array(...).set(...)` | `ownedRange` proves the private region pointer, explicit allocation capacity, pointer width, and current `Memory.buffer` range | Source offset/length are safe integers and fit the source's intrinsic typed-array slots; the exact native base-class view prevents a subclass override from widening the write | Synchronous active lease only; **guarded scratch-core sink, not a raw allowance** |
| `host/src/kernel-scratch.ts::KernelScratchLease.fill` — `Uint8Array(...).fill(...)` | `ownedRange` supplies exact checked start/end inside the allocation and current memory | Fill length/value validation occurs before construction | Synchronous active lease only; **guarded scratch-core sink, not a raw allowance** |
| `host/src/kernel.ts::WasmPosixKernel.#writeKernelBytes` — intrinsic `Uint8Array.prototype.set` on `#getMemoryBuffer()` | `checkedWasmImportMemoryRange` normalizes the raw import pointer and proves the Rust-lent pointer, explicit/generated capacity, width, and current memory | The producer's intrinsic byte span must not exceed the supplied capacity; a typed-array subclass cannot under-report its real span | Complete synchronous import; the method and memory getter are runtime-private; **Rust-lent allowance** |

## Executable reproductions and regression coverage

The focused regressions are executable in
`host/test/kernel-scratch-transfer-boundaries.test.ts` and are designed to
fail at the old admission or sentinel condition. The old-source evidence below
is the exact pointer/capacity arithmetic from audited head `6d923c6`; the
current tests exercise the corrected boundary. The regressions were not
transplanted into and run from the historical head, so this table does not
claim a separate old-head test execution.

| Confirmed old path and executable regression | Exact unsafe evidence on `6d923c6` | Current boundary asserted |
|---|---|---|
| `kernel_wait_child_poll` result pointer/capacity and child-state consumption | The ABI-42 export accepted only a bare output pointer, so the interface could not prove that the destination owned the complete 160-byte `KernelWaitResult` before selecting the sole waitable child event | The real compiled kernel rejects pointer zero and capacities 159/161 without changing either canary or consuming the event. Exact capacity 160 publishes the complete result and reaps the child, and the next exact-capacity call returns `ECHILD` |
| `WasmPosixKernel` cached public/audio scratch across a second `init` | The wrapper cached allocator-owned regions containing the first generation's instance, memory, pointer, and capacity, but a later initializer could replace only the wrapper's current instance/memory. Subsequent public/audio calls could select the old region and old snapshotted export while other wrapper state named the replacement generation; a failed second instantiate could also leave new memory paired with the old instance | `kernel-initialization-lifetime.test.ts` allocates and uses both cached regions on wasm32 and wasm64, rejects concurrent and post-success reinitialization before compile/instantiate or state mutation, proves the original generation still works, and proves a failed first attempt clears partial state before one clean retry |
| Public `WasmPosixKernel.setsockopt` scalar option | The old wrapper called `kernel_setsockopt(fd, level, optname, value)` directly. Rust's actual fifth-argument signature expected `{ optval_ptr, optlen }`, so an ordinary scalar became an unowned kernel pointer and no capacity crossed the boundary. Omitting this export from the hand-reviewed scratch list also exposed the prior static classification gap | `kernel-public-scratch.test.ts` targets wasm32 and wasm64, requires the pointer type appropriate to the kernel width, observes exactly four staged little-endian bytes, requires `optlen == 4`, and preserves both low-memory and post-allocation canaries. The audit mutation fixture proves a generated `kernel_setsockopt` direct call remains denied even when the scratch list omits it |
| Channel `request_flags` capture and reuse | Before generated request flags, the host saw only `syscall_nr`; a plain call and cancellation-point call using the same number were indistinguishable, and a reused mailbox carried no authoritative call-site identity | wasm32/wasm64 fixtures publish zero, cancellation-point, and cancellation-point-plus-wake values for one number; they verify one-shot capture and clearing, reject unknown or inconsistent bits, retain the same detached flags through retry, and prove sequential mailbox reuse cannot inherit them |
| `ptyMasterWrite` — “chunks PTY input at the exact scratch capacity and capacity + 1” | The old single `.set(data, scratchOffset)` accepts more than the 65,608-byte allocation because only total linear memory constrains the typed-array write | 65,608 is one call; 65,609 becomes calls of 65,608 and 1; 16 KiB sentinel after the allocation is unchanged |
| `setCwd` — “rejects an oversized initial cwd before copying it” | `CH_TOTAL_SIZE + 1` encoded bytes are copied first; only the later Rust call applies `PATH_MAX` | Host rejects before `kernel_set_cwd` and before scratch mutation |
| `handleWritev` — “accounts for every writev table and alignment byte” | 1,024 iovecs contain 57,344 payload bytes, so the old `57,344 + 8,192 == 65,536` admission passes. Per-entry four-byte alignment makes the real footprint 68,608, writing 3,072 bytes beyond the data allocation | The caller table and all nested ranges are validated, but no second kernel table is constructed. Exactly 57,344 flattened bytes use the main data region in one write; the tail sentinel stays intact |
| `handleReadv` — “subtracts the complete readv iovec table from data capacity” | 1,024 entries request 65,528 data bytes. The old fast limit subtracts only one eight-byte entry, while the actual table is 8,192 bytes; the footprint is 73,720, or 8,184 bytes beyond the 65,536-byte data allocation | `IOV_MAX` and every destination are checked before dispatch; one 65,528-byte flat read is scattered through the caller capacities and the tail sentinel is unchanged. A larger aggregate uses one tokenized allocation rather than a partial table/data fit |
| `handleSendmsg` / `handleRecvmsg` — `IOV_MAX + 1` cases | The old path calls Rust instead of rejecting count 1,025 with `EINVAL` | Count 1,025 is rejected before scratch mutation or Rust dispatch |
| `handleSendmsg` / `handleRecvmsg` — complete-layout boundary and historical allocation-sized table cases | Count 8,192 alone consumes 65,536 kernel-table bytes, but the old path also writes the 28-byte kernel message header and aligned optional/data sections. That historical count is above `IOV_MAX`, so current code rejects it at the count check rather than exercising the capacity boundary | One 65,500-byte iovec makes the complete header/table/data layout exactly 65,536 bytes and is accepted; 65,501 is rejected before dispatch. Exactly 1,024 zero-length entries are accepted, while the historical 8,192-entry case is rejected by `IOV_MAX`; the sentinel stays unchanged |
| `handleSendmsg` / `handleRecvmsg` multi-iovec behavior | The old kernel-facing path serialized the caller's full count but Rust read only the first table entry, so later payload sources/destinations were silently ignored even when all ranges fit | wasm32 and wasm64 send flatten every entry in order; receive scatters the detached result across every entry, including correctly skipping a zero-length middle entry |
| wasm64 ancillary translation and capacity | The old path copied a native 16-byte-aligned wasm64 `cmsghdr` into a kernel parser expecting the 12-byte wasm32 shape. On receive, `CMSG_SPACE(sizeof(int)) == 24` could be misread as canonical room for two FDs even though one native record has only one logical FD of data | Generated native layouts translate to/from the fixed 12-byte canonical wire. A native `CMSG_LEN(sizeof(int)) == 20` maps to exactly one canonical FD; exact native capacity matrices, poisoned padding, `MSG_CTRUNC`, and sequential shorter reuse preserve caller canaries |
| Malformed ancillary length and canonical output | A wrapped/overlong length could reach unchecked pointer arithmetic or allow a returned record to publish partial guest output | Wrapped native input fails before scratch mutation. Partial, overlong, misaligned, or capacity-plus-one canonical output becomes `EIO` before any payload/name/control/header publication |
| Kernel channel C-string allocation boundary | The old Rust scanner accepted a bare kernel pointer, stopped at a duplicated 4,096-byte constant, and did not carry the channel allocation capacity that authorized each dereference | Pointer zero, before-start, exact-end, overflow, and a missing NUL before the allocation end return `EFAULT`; a NUL in the last owned byte succeeds, and a generic non-path string larger than `PATH_MAX` remains valid |
| Positive-count null dynamic buffers and zero-count null buffers | The old generic host path did not make a positive `Arg` extent independently imply a non-null source/destination, while a raw zero-count process pointer could cross address spaces even though no caller bytes were borrowed | wasm32 and wasm64 `read`/`write` with count 1 and pointer 0 fail with `EFAULT` before dispatch. Count 0 with pointer 0 reaches Rust only as the allocation start with zero extent, never as the caller address |
| Positive-size fixed output nullability (`pipe(NULL)` and `uname(NULL)`) | Absence of `required` metadata was interpreted as permission for null, so fixed outputs could reach Rust without an owned destination and write through kernel address zero | Every generated pointer descriptor is exactly one of required or nullable; the reviewed nullable set is asserted exactly. wasm32 and wasm64 `pipe`/`uname` null outputs fail before kernel dispatch |
| Non-null `Deref` outer buffer with a null length pointer | `accept`, `accept4`, `recvfrom`, `getsockname`, and `getpeername` derive output capacity from a separate `socklen_t *`. The old host could leave the non-null caller outer pointer in adjusted kernel args when that capacity pointer was null, crossing address spaces before later rejection | wasm32 and wasm64 `accept`, `accept4`, and `recvfrom` reject the malformed optional pair before scratch mutation or dispatch; the same shared planner covers every `Deref` descriptor |
| Legacy `readdir` zero-capacity producer over-report | The zero-length output planner retained ordinary byte-count producers but dropped outputs whose actual length comes from another staged record. A hostile successful `d_namlen = 1` could therefore publish the fixed dirent while evading the zero-byte name capacity | wasm32 and wasm64 retain the empty owned output record even with generated `copyOutLength`, reject the positive name length with `EIO`, publish neither dirent nor name, and preserve process and scratch canaries |
| Absent versus zero-capacity optional socket-address output | The descriptor planner staged and later copied an `accept`/`accept4`/`recvfrom` length pointer even when the address pointer was null, although POSIX makes that field ignored. Nested `recvmsg` likewise collapsed absent `msg_name` and a supplied zero-capacity name into the same null kernel pointer, so it could overwrite an ignored native `msg_namelen` or fail to report the complete length for a present zero-capacity result | The generic nullable-`Deref` planner now canonicalizes an absent outer/length pair before any caller-memory read, while non-null output still requires its length. The canonical message wire represents a present zero-capacity name with the next allocation-owned cursor and represents absence with null; Rust and the host publish the complete length only for the former. wasm32/wasm64 regressions cover valid, out-of-range, negative, and unsafe-high-bit ignored length pointers, stale absent send/receive name lengths, present zero capacity, unchanged canaries, and both fixed socket descriptor forms |
| One-snapshot, order-independent `Deref` planning | The old planner could size a destination from one `socklen_t` read and stage a later, mutated value; it also depended on the generated dynamic descriptor preceding the fixed length descriptor. A larger staged value could authorize Rust to use bytes the host had not reserved | The regressions mutate 4 to 28 between hypothetical reads and reverse the generated `recvfrom` descriptor order. The host performs one caller-memory read, stages that same value, and leaves the adjacent canary unchanged. Rust validates allocation order/range, with the documented alignment-bucket limitation because no separate unpadded capacity is encoded |
| Option-sensitive `prctl` argument 1 | The generic descriptor treated argument 1 as a fixed 16-byte pointer for every option, so scalar operations such as `PR_SET_NO_NEW_PRIVS` had their value replaced by a scratch address | wasm32/wasm64 scalar options preserve the canonical low-32-bit value and stage no buffer; `PR_SET_NAME`/`PR_GET_NAME` stage exactly 16 bytes in the correct direction and reject null before dispatch |
| Vector/message wasm64 nested pointers | `Number(bigint)` loses an unrepresentable iovec/base/header pointer and permits an aliased range to reach Rust | Raw bigint remains intact through guest-width and safe-integer checks; failure precedes mutation |
| Public poll exact allocation boundary | The public wrapper used the unrelated `IOV_MAX` value 1,024 even though its owned 65,536-byte region can hold 8,192 generated eight-byte `pollfd` records | Exactly 8,192 records are admitted and 8,193 is rejected before mutation; readiness parsing uses generated offsets |
| Large `preadv` / `pwritev` positioned offset and operation count | Reassembling the signed high and unsigned low words as a JavaScript `Number` rounds `2^53 + 1` down to `2^53`; splitting at channel capacity also changes one vector into several positioned operations | The complete offset remains `bigint` and one token executes one required `host_pread`/`host_pwrite` call. Native tests record the exact offset and unchanged OFD cursor; host import tests reconstruct the exact two-word value for wasm32 and wasm64 |
| Ordinary and large `pread` / `pwrite` positioned offset | The generic ordinary path converted the signed i64 channel slot to `Number`; large transfers reused that rounded value, and seek/read-or-write/restore could race a shared OFD or fail to restore after an I/O error. Shared-mapping follow-up could also index the rounded page | Both caller widths preserve `2^53+1`; Rust issues one true positioned host import without touching the cursor. Number-only backends return `EOVERFLOW`, and an offset that cannot index shared-mapping state losslessly triggers authoritative refresh instead of an aliased update |
| Rejected ambient/proxy kernel-entry authority | An interim gate proxy protected calls made through the proxy but did not prove that every callback still held that exact receiver. A synchronous backend callback could still invoke a raw-target method while Rust was active. Proxy-returned containers, accessors, or closures could likewise retain the target. Patching individual callbacks would leave the next return edge as another authority leak | The proxy design was removed. `KernelEntryGate` now issues a frozen lexical context whose scoped facade is bound in a private gate/scope registry, and the worker stores no ambient context. Gate tests reject unscoped generic callbacks, retained scoped exports after revocation, cross-gate scopes, prototype/descriptor mutation, and observer reentry. `kernel-entry-context-audit.test.ts` mutation cases require every production export-bearing call chain to carry the exact context or open a fresh ingress. A prior source checkpoint reported zero findings, but the widened reservation detector and rigid stage → execute → finish helpers changed afterward; both the entry-context and independent kernel-memory ownership assertions remain pending until rerun on stabilized source |
| Detached host-effect failure and reentry ordering | Running an observer while export authority was still ambient could let it steal the next export permit, append work to its own privileged phase, or make one throwing callback skip required later cleanup. Treating channel publication or scheduler registration as an ordinary observer could instead continue after required protocol state failed. A queued-then-thrown “test helper” could also reject its caller while retaining the values for later execution | `KernelEntryGate` owns a fixed, ordered batch of typed records and revokes the scope before running any of them. Immediate-only ingress rejects before queueing or retaining caller values; ordinary void ingress owns the FIFO explicitly. Observer throws and non-synchronous returns are reported and later independent records continue. Serialized host operations reject Promise/thenable escape and fail-stop because the continuation already exists. Protocol failure, or a fatal latch reached from any record, privately poisons the generation and discards every later effect and queued ingress before the worker fatal observer runs. Gate and production-worker regressions cover immediate/deferred ordering, retained-scope rejection, callback reentry, Promise returns, hostile fatal reporting, and no later publication/relisten/follower after failure |
| Host-region caller validation versus generation failure | `reserveHostRegion` and `reserveHostRegionAt` originally validated guest pointer/length geometry inside the generation-fatal entry callback. A malformed caller range could therefore poison a coherent kernel even though no Rust export had run; fork-from-pthread could also allocate a child PID before discovering that its requested control-slot range was impossible | `host-process-pointer-width.test.ts` proves negative dynamic length and an out-of-domain fixed wasm32 range reject before the genuine Wasm export is called, then a valid request succeeds on the same generation. Fork validates the exact control-slot range before allocating the child PID. Export-return validation remains inside the gate: a returned range that exceeds the guest domain is wrapped as a generation-fatal protocol failure, while an exact wasm32 end at 4 GiB and mixed kernel/guest widths retain their lossless bit patterns |
| Real `Getpid` completion with pending PTY output | Delivering PTY bytes after setting `CH_COMPLETE` or relistening lets a PTY callback reenter and replace reusable scratch before the original bytes are detached; delivering while the scope is live lends the callback export authority | `kernel-large-transfer-protocol.test.ts` drives the production `Getpid` channel on wasm32 and wasm64 in immediate and deferred cases. The PTY callback observes `CH_PENDING` and no relisten, its reentry queues, then the host publishes `CH_COMPLETE`, relistens, and only afterward admits the queued ingress |
| Real `FUTEX_WAKE` completion and kernel wake batch | Publishing the futex syscall before draining Rust's wake records permits callback/retry work to reuse scratch or observe a completed wake while the corresponding waiters remain undelivered | The production-path wasm32/wasm64 regression issues genuine `FUTEX_WAKE`, proves one wake record is drained under the same lexical scope, and reaches the real raw channel-completion path only after that drain |
| Host-driven process exit through a trapping export | Guest `kernel_exit` intentionally does not return. Calling it from the host makes its expected trap indistinguishable from a partial/incoherent export unwind, while treating that trap as success weakens the generation-fatal rule | Rust exposes required `kernel_commit_process_exit(status)`, sharing the authoritative cleanup helper but returning the low eight status bits. The host also requires `PROCESS_STATE_EXITED` before detached callbacks. A mismatched return test proves the fatal latch stops polling and leaves every channel inert rather than publishing `EIO` or relistening |
| Host append rejection, short result, and stale EOF during transfer syscalls | `sendfile`, `copy_file_range`, and `splice` consumed a source cursor or pipe before a later append failure. A separate preflight `fstat` could also apply `RLIMIT_FSIZE` to an EOF that no longer belonged to the append transaction | Four Rust `append_transfer_` regressions cover external `EOPNOTSUPP` with unchanged regular cursor and pipe bytes, a short result that consumes only the reported prefix, exact-limit/limit-plus-one clipping, and stale-too-large/stale-too-small `fstat` values. Host append owns the current EOF and only its reported prefix is committed |
| Large vector one-operation semantics | Chunking a 65,538-byte two-iovec AF_UNIX datagram produces multiple messages even though POSIX defines one `writev` call | The real-musl fixture writes and reads one 65,538-byte datagram, verifies every byte, then proves the nonblocking queue is empty. The same guest is the required Node and real-Chromium operation-boundary target |
| Token allocation/capacity/lifetime | A pointer-only or retained grow-by-leak scheme can overrun, leak old regions, or replace bytes while a host callback is using them | Focused wasm32/wasm64 protocol tests cover exact capacity and +1, `ENOMEM`, invalid pointer/range, sequential tokens, deferred reentrant channels, producer over-report, retry cancellation, and execute/cancel traps. Traps latch the kernel fatal state, clear queued work, and make direct/retry/listener dispatch inert |
| Obsolete direct variable-I/O exports | The old bare scalar/vector exports could check only total memory, and a legacy guest pointer names process memory/native layouts rather than a capacity-bearing kernel allocation | Source/snapshot tests require the four scalar exports, four vector exports, and bare-pointer write preflight to remain absent. Unknown `kernel.*` imports fail admission; a declared-shell scan found no raw vector import among 193 current program artifacts |
| `Getaddrinfo` generic descriptor — “copies only getaddrinfo's four-byte result before the caller canary” | The old fixed 256-byte output descriptor copies 252 bytes beyond musl's four-byte result object | Detached copy-back is exactly four bytes and preserves a 252-byte canary |
| `handleGetgroups` and `kernel_getgroups` | The old generic call passes the caller's process pointer as if it were a kernel pointer; Rust writes one `u32` without receiving the owned destination capacity | Size zero lends pointer/capacity zero; positive size lends exactly four bytes; Rust rejects capacity 0/3 and accepts 4/5; detached gid copy precedes reuse |
| `Setgroups` generated descriptor | The old raw pointer crosses address spaces. The current Rust implementation does not dereference it, so this is an unsafe contract rather than a claimed observed overwrite | Exactly 16,384 gids fit; 16,385 is rejected; count zero ignores even an unrepresentable pointer; positive null returns `EFAULT` |
| Request-aware `ioctl` — FIONREAD canary and exact capacities | The old generic 256-byte argument copies back 252 bytes beyond a four-byte FIONREAD object; it also cannot distinguish scalar/no-argument requests from pointer requests | FIONREAD copies exactly 4; wasm32 TIOCGPTN is 4, wasm32 DRM VERSION is 36, wasm64 DRM VERSION is 64; one-byte-short/null fail before mutation; scalar/no-arg/unknown stage no pointer |
| Width-incompatible `ioctl` requests | The old contract has no lossless distinction for pointer-bearing wasm32-only layouts such as `GLIO_QUERY` and wasm32 DRM VERSION | wasm64 rejects those known requests with `EOVERFLOW` before conversion or copy |
| Caller-native process records | Fixed wasm32/partial descriptors under-copy or copy back the wrong layout for wasm64; `sigevent` was treated as 16 rather than 64 bytes; `sysinfo` used stale syscall 208 instead of musl 269 | `tests/abi/{process-native-layouts,fixed-process-layouts}.c`, Rust exact/short tests, and host `sysinfo` exact-end/one-byte-short tests cover the enumerated 12/24, 16/32, 32/64, 64, 88/120, 312/368, 128, 112, and 48-byte records |
| Signal dequeue output capacity and complete `SA_SIGINFO` record | The old `kernel_dequeue_signal(pid, tid, out_ptr)` accepted a bare kernel pointer, while its 44-byte payload inside a 48-byte reserved channel area omitted a complete raw `si_value` plus source metadata | `signal_delivery_output_requires_nonnull_exact_capacity` rejects null, 55, and 57 while accepting exactly 56; `signal_delivery_record_serializes_every_field_at_the_shared_offsets` covers the full generated record. The real-musl `process-native-layout` fixture targets wasm32 and wasm64 handler-side C reconstruction, raw value width, `si_code`, PID, and UID |
| Mqueue notification drain and registration validation | The old one-argument drain export had no allocation-capacity proof. A negative Rust errno is truthy in JavaScript, so the old host could parse unchanged reusable bytes as a pending `{pid, signo}` notification. `mq_notify` also admitted invalid signal numbers into the one-shot registration slot | Source requires an exact eight-byte destination and queues the full raw value with `SI_MESGQ` and sender metadata independently of the wake record. The host regression accepts only integer results 0/1 and fails closed on `-EINVAL` without waking or signaling. Native coverage rejects 0, `NSIG`, and `u32::MAX` without occupying the slot, then proves a valid registration succeeds. The real-Wasm export regression rejects pointer zero and capacities 7/9 without consuming or mutating the pending record, then accepts capacity 8 and preserves both destination canaries |
| Signal sender metadata for plain raise/kill versus queued sources | Plain self-raise previously reached the metadata-bearing queue with PID/UID zero, making handler `siginfo_t` inconsistent with the authoritative process identity | `test_raise_preserves_self_sender_metadata` and `process_signal_metadata_distinguishes_kill_from_sigqueue` distinguish SI_USER/SI_QUEUE while preserving sender PID/UID and raw queued value. The same rebuilt real-musl Node fixture checks the handler-visible fields |
| `handleEpollCtl` / `handleEpollPwait` native event layout | A stale 12-byte assumption cannot represent musl's required padding before 64-bit `data` and proves the wrong output range | Exact record is 16 bytes: events offset 0, padding 4–7, data offset 8; exact-end and one-byte-short input/output tests verify padding and data |
| wasm64 `handleIpcShmat` | `shmaddr >>> 0` aliases a hint above 4 GiB to its low 32 bits before mmap/attachment logic | `0x1_0000_0000n` reaches mmap unchanged; values above `Number.MAX_SAFE_INTEGER` fail before attachment |
| wasm64 `handleIpcShmdt` | `args[0] >>> 0` can select and detach an unrelated low mapping for a high native pointer | A high address equal to an existing low key plus 4 GiB neither aliases nor detaches the low mapping |
| wasm64 `msgctl` `IPC_STAT`/`IPC_SET` | Fixed 96-byte wasm32 descriptor validates/stages the wrong range instead of the 120-byte LP64 structure | Required size query selects 96/120 and exact/short ranges |
| wasm64 `semctl` `IPC_STAT` | Fixed 72-byte wasm32 layout is selected instead of the 88-byte LP64 structure | Required size query selects 72/88; array size comes from permission-aware Rust preflight |
| wasm64 `shmctl` `IPC_STAT`/`IPC_SET` | Fixed 88-byte wasm32 descriptor validates/stages the wrong range instead of the 112-byte LP64 structure | Required size query selects 88/112 and exact/short ranges |
| Direct and nested socket-address capacity | The native `msghdr` path validated the caller range but accepted raw `msg_namelen` as both an input length and receive scratch capacity. That bypassed the direct bind/connect/sendto input ceiling. A first hardening pass then treated 110-byte `sockaddr_un` as the producer maximum, but an exact 108-byte non-NUL pathname legitimately makes `getsockname()` report 111 bytes, and storing a canonicalized relative bind name could make that report unbounded in a deep current directory. Several AF_UNIX producers also wrote no family prefix at one-byte capacity, and `accept4` either left the result length stale or cleared bytes beyond the actual address | The generated 128-byte `sockaddr_storage` is the complete generic input/output staging ceiling; 110 bytes remains only the concrete AF_UNIX parser ceiling. wasm32/wasm64 direct inputs and nested `sendmsg` accept 128 and reject 129. Generic address outputs and `recvmsg` reserve at most 128, reject a producer report of 129 with no partial publication, and leave unused caller bytes untouched. When an address is requested, `getsockname`, `getpeername`, `accept4`, `recvfrom`, and `recvmsg` report the complete address length while copying only the caller's zero-, one-, or two-byte AF_UNIX prefix; an absent optional address leaves its ignored length untouched. Accept rolls back its new descriptor if requested peer-address publication fails. `SocketInfo` retains the bounded original bind name while the Unix registry independently owns its canonical namespace key |

The expanded parameterized coverage includes those failures plus caller
address zero, both main and tokenized vector paths, large read/write, select/pselect,
`ppoll` special-pointer conversion, epoll, wasm32/wasm64 System V IPC control
layouts, generic descriptor invalid lengths, lease-time staging, and
Linux-compatible `MSG_TRUNC`. Final case counts belong in the post-retarget
validation report, not this in-progress rehearsal record.

Validation of the abstraction itself found one performance regression rather
than an ownership escape. `intrinsicBufferByteLength` brand-checked a shared
kernel `Memory.buffer` by invoking the non-shared `ArrayBuffer` getter first,
so every range proof threw and caught a `TypeError` before the genuine
`SharedArrayBuffer` getter succeeded. A V8 profile attributed about 27 seconds
of a 38-second focused Sortix poll run to that repeated exception. The current
implementation caches only the successfully brand-checked intrinsic getter by
genuine buffer identity; it still calls that getter on every proof, so memory
growth cannot reuse a stale byte length. Focused tests cover ordinary and
shared memories, post-growth live bounds, captured intrinsics after prototype
replacement, and one failed brand probe per shared buffer identity. Default
watchdog conformance remains part of the exact-candidate validation gate.

Additional focused files cover the complete abstraction:

- `host/test/kernel-scratch-region.test.ts`: exact capacity/capacity+1,
  negative/fractional/unsafe integer inputs, pointer arithmetic, null,
  end-of-memory, allocation failure, invalid allocator range, wasm32/64,
  signed-high allocator/reservation results, sequential/nested/async use,
  single-use revocation, hostile `then`/typed-array methods, escaped views, and
  `memory.grow()`.
- `host/test/kernel-public-scratch.test.ts`: removal of low-address scratch,
  public capacity, audio counts, signed-high raw import pointers, hostile
  producer views, exact KMS mode-info size, Rust-lent network output bounds,
  and public scalar `setsockopt` staging with exact four-byte capacity,
  wasm32/wasm64 pointer types, and canaries.
- `host/test/kernel-initialization-lifetime.test.ts`: both kernel pointer
  widths, cached public/audio scratch, post-success cross-entry-point
  initialization rejection, concurrent initialization, original-generation
  preservation, and failed-first-attempt cleanup/retry.
- `host/test/spawn-blob-transport.test.ts`: ordinary and tokenized large
  transport, fresh reservation on reuse, begin/allocation failure and retry,
  invalid pointer/capacity, copy-failure cancellation, stale/missing exports,
  host reentry exclusion, exact whole-blob ceiling, exact and
  maximum-plus-one argv/environment/action counts, exact aggregate `ARG_MAX`
  and `ARG_MAX + 1` for both caller pointer widths, and wasm64
  pointer/token/capacity.
- `crates/kernel/src/spawn.rs` unit tests: malformed maximum counts, exact and
  maximum-plus-one counts, exact and oversized argv/environment
  representation, action-path `PATH_MAX`, complete wire ceiling,
  duplicate-offset amplification rejection before allocation, injected
  reserve failure with no state/token mutation and successful retry,
  growth/reuse, nonblocking begin/query contention, threaded blocking
  commit/cancel settlement, exact token cancellation/consumption, stale
  tokens, capacity+1, and token exhaustion without wraparound.
- `crates/kernel/src/scratch_alloc.rs` unit tests: zero, ordinary, exact
  aligned layout ceiling, and ceiling-plus-one allocator-layout inputs return
  a value/error instead of trapping. Host region tests separately cover a
  zero allocator result and an allocator-returned range outside current
  memory.
- `crates/kernel/src/ipc_wire.rs` unit tests: wasm32 time64 and wasm64 LP64
  `msqid_ds` (96/120 bytes), `semid_ds` (72/88), and `shmid_ds` (88/112)
  offsets, exact no-overwrite boundaries, width-aware `IPC_SET` field reads,
  invalid widths, short inputs/outputs, oversized LP64 fields, and an
  unrepresentable semaphore count.
- `tests/abi/process-native-layouts.c` and
  `scripts/check-process-native-layouts.sh`: executable wasm32/wasm64 musl
  size-and-offset drift checks for signal-stack, signal-information,
  message-queue, filesystem-statistics, and system-information records,
  including the native `union sigval` width.
- `tests/abi/fixed-process-layouts.c`,
  `scripts/check-fixed-process-layouts.sh`,
  `tests/abi/sysv-ipc-layouts.c`, and
  `scripts/check-sysv-ipc-layouts.sh`: fixed-record and System V
  structure-size/offset checks for both caller widths.
- `crates/kernel/src/process_wire.rs` and
  `host/test/process-native-layout.test.ts`: exact-size and capacity+1 parsing
  and serialization tests, zeroed padding/reserved bytes, and end-to-end
  wasm32/wasm64 syscall round trips. The current real-musl fixture also
  installs an `SA_SIGINFO` handler and verifies the generated 56-byte delivery
  record reconstructs native `si_value`, `si_code`, PID, and UID; its mqueue
  cases preserve four-byte wasm32 and eight-byte wasm64 values and reject
  invalid `mq_notify` signums. Focused host boundary tests separately
  prove `sysinfo` exact-end admission, one-byte-short rejection, and that a
  negative mqueue drain result cannot decode stale scratch. The two runtime
  cases are self-contained and set `useDefaultRootfs: false`; Node and browser
  execution remain external validation targets.
- `crates/kernel/src/mqueue.rs`, `crates/kernel/src/signal.rs`,
  `crates/kernel/src/syscalls.rs`, and
  `host/test/kernel-scratch-transfer-boundaries.test.ts`: invalid mqueue
  signums leave the registration slot free, `SI_MESGQ` and sender metadata
  remain in the Rust-owned signal queue, plain self-raise reports the real
  sender, and the host publishes no notification after a negative drain
  result.
- `host/test/sysv-ipc.test.ts`: end-to-end wasm32/wasm64 message-queue,
  semaphore, and shared-memory control operations, including `IPC_SET`. Its
  two self-contained runtime cases also set `useDefaultRootfs: false`.
- `crates/shared/src/ioctl_contract.rs`, the ioctl tests in
  `crates/kernel/src/wasm_api.rs`, and
  `host/test/kernel-scratch-transfer-boundaries.test.ts`: sorted
  request-table uniqueness, argument-kind/direction agreement, exact Rust
  slice lengths, exact wasm32/wasm64 capacities, caller canaries, and
  unsupported-width rejection.
- `host/test/shared-memory-coherence.test.ts`: high-address `shmat` hint
  preservation, rejection of a non-lossless hint before kernel attachment,
  and proof that high `shmdt` does not alias a low mapping.
- `host/test/kernel-worker-copyback.test.ts`: detached poll output survives an
  immediate timeout without rereading reused scratch; error/retry paths do not
  publish another operation's bytes.
- `host/test/deferred-worker-start.test.ts`: a deferred clone failure clears
  the originally validated parent-TID word even when the guest replaces its
  mutable mailbox before worker construction fails. The real parked mailbox
  remains owned through synchronous `Worker` construction, so constructor
  failure replaces the provisional success before exactly one completion is
  published.
- `host/test/host-process-pointer-width.test.ts`: invalid dynamic and fixed
  host-region requests reject before the genuine Wasm export and do not poison
  the generation; a malformed export result remains generation-fatal. The same
  cases cover mixed kernel/guest pointer widths and exact wasm32 end-of-domain
  arithmetic.
- `host/test/kernel-scratch-contract.test.ts` and
  `host/test/wasm-memory-write-audit.test.ts`: compiler-backed repository drift
  guard plus focused ownership-propagation, write-kind, escape, exact-allowlist,
  direct/aliased/destructured/computed pointer-export invocation, wrapped
  callable argument/return/persistent-storage escape,
  `call`/`apply`/`bind`, reflective invocation fixtures, the exact
  reserved-spawn transaction proof, and proof that the complete generated
  export set defaults to denied even when a raw call's name is omitted from
  the runtime scratch list.
- `host/test/process-wait-lifecycle.test.ts`,
  `host/test/kernel-blocking-retry-snapshot.test.ts`, and the focused
  sleep/signal/readiness/lock/pipe/FIFO tests: generated request-flag offsets
  and known-bit masks; plain, enabled, masked, disabled, wake-without-point,
  unknown, and stale combinations for one syscall number; capture-and-clear;
  cancellation before and after every host-owned registration; disabled
  finite-deadline preservation; immutable replay; and sequential mailbox reuse
  on wasm32 and wasm64.
- `crates/kernel/src/{process_table,socket,unix_socket,syscalls}.rs` native
  tests: root-only inherited socket graphs, one-sided `FD_CLOFORK` and
  retry-only peers, both-root preservation, alias deduplication, AF_UNIX
  rename/reuse exact owners, abstract/pathname cleanup, and transactional
  allocation/invalid-root failure. These tests preserve the explicit
  same-process AF_UNIX datagram transport boundary.
- `crates/shared/src/host_abi.rs`,
  `crates/kernel/src/channel_scratch.rs`,
  `host/test/generated-abi.test.ts`, and
  `host/test/kernel-scratch-transfer-boundaries.test.ts`: every generated
  descriptor selects exactly one of required or nullable, the complete
  nullable set is reviewed explicitly, and `prctl` remains absent from generic
  pointer metadata. Host and Rust cases cover positive-null and canonical
  owned-empty `Arg` buffers, required fixed outputs, exact 16-byte
  `PR_SET_NAME`/`PR_GET_NAME`, scalar `prctl`, null nested `socklen_t`
  pointers, one-snapshot `Deref` staging under descriptor reordering, and
  wasm32/wasm64 parity. The Rust dispatcher source guard also matches each raw
  process-address context exactly instead of approving only an occurrence
  count.
- `host/test/kernel-scratch-transfer-boundaries.test.ts` plus
  `crates/kernel/src/socket_wire.rs`: a zero-length `sendmsg` iovec is
  transported as `{ base: 0, len: 0 }`, while the Rust consumer selects a
  valid empty slice before any `from_raw_parts` call. Pure Rust tests execute
  malformed canonical control lengths, partial/trailing records, invalid-FD
  propagation, and the zero/one-iovec wire limit on the native test target.

## Evidence boundaries and external gaps

The tables above record source ownership and executable regression targets.
They do not establish a current-head test result. This documentation-only
finalization does not claim Node, browser, conformance, performance, or
full-build evidence.

Framebuffer, Direct Rendering Manager (DRM), OpenGL, process-memory,
shared-mapping, and worker-message transfers remain deliberately outside the
allocator-scratch abstraction because they have different owners and
lifetimes. The static contract must prove that allocator scratch does not
escape into them; each subsystem still needs its own range, lifetime, and host
validation.

PR #1097 merged as
`c7d039794a43788acfa0b0aea30a700c257f57cb`, and retargeting is complete.
Before readiness, the external PR ledger must name the frozen exact head and
record the generated-file/ABI checks, focused host and Rust regressions,
complete required conformance surface, and any Node/browser or measurement
evidence needed for the claims actually made. The draft remains unapproved and
unmerged until that ledger is current and Brandon explicitly approves it.

## Platform and spawn contract sources of truth

`crates/shared/src/lib.rs::platform_limits` is authoritative for Kandelo's
advertised `ARG_MAX`, `PATH_MAX`, and `IOV_MAX`. The ABI generator writes those
values to TypeScript and a musl header; the public `limits.h`, musl's compiled
`sysconf`, the TypeScript host, and Rust consume those generated or shared
values. `crates/shared/src/lib.rs::spawn_contract` separately owns the wire
layout and defensive parser count caps. Its generated private C header aliases
the generated platform limits instead of repeating their numbers. Compile-time
assertions require every wire count, length, offset, and the derived complete
ceiling to remain representable by the protocol's `u32` fields. Rust unit
tests and generated-file checks make that representability and cross-language
freshness executable drift contracts.

| Value | Meaning | Classification |
|---|---|---|
| 4,194,304 | Combined argv/environment bytes, including representation overhead | Advertised `ARG_MAX` platform limit |
| 4,096 | Path bytes including terminating NUL | Advertised `PATH_MAX` platform limit |
| 1,024 | Maximum iovec entries | Advertised `IOV_MAX` platform limit |
| 4 bytes (`u32`) | Width of each argv/environment offset into the trailing strings region | Cross-layer wire layout |
| 40 bytes | Complete spawn header | Cross-layer wire layout |
| 28 bytes | Complete file-action record | Cross-layer wire layout |
| 4,096 argv, 4,096 env, 1,024 actions | Defensive parser count caps | Implementation limits, not extra POSIX limits |
| 8,417,320 | Derived complete blob ceiling: `ARG_MAX + header + actions * (record + PATH_MAX)` | Transport/parser safety ceiling, not `ARG_MAX` |

Header fields are little-endian and contiguous:

| Header field | Type | Byte offset |
|---|---|---:|
| `argc` | `u32` | 0 |
| `envc` | `u32` | 4 |
| `action_count` | `u32` | 8 |
| `attr_flags` | `u32` | 12 |
| `pgrp` | `i32` | 16 |
| reserved pad | `u32` | 20 |
| `sigdef` | `u64` | 24 |
| `sigmask` | `u64` | 32 |

Each little-endian action record uses the following generated layout:

| Action field | Type | Byte offset |
|---|---|---:|
| `op` | `u32` | 0 |
| `fd` | `i32` | 4 |
| `newfd` | `i32` | 8 |
| `path_off` | `u32` | 12 |
| `path_len` | `u32` | 16 |
| `oflag` | `i32` | 20 |
| `mode` | `u32` | 24 |

The generated action opcodes are:

| Opcode | Operation |
|---:|---|
| 0 | `OPEN` |
| 1 | `CLOSE` |
| 2 | `DUP2` |
| 3 | `CHDIR` |
| 4 | `FCHDIR` |

The wire transports musl's complete flag byte unchanged. Transport does not
claim implementation: the kernel deliberately reexports and interprets only
the supported subset.

| Bit | Transported flag | Kernel behavior |
|---:|---|---|
| `0x01` | `POSIX_SPAWN_RESETIDS` | Transported; not implemented |
| `0x02` | `POSIX_SPAWN_SETPGROUP` | Implemented |
| `0x04` | `POSIX_SPAWN_SETSIGDEF` | Implemented |
| `0x08` | `POSIX_SPAWN_SETSIGMASK` | Implemented |
| `0x10` | `POSIX_SPAWN_SETSCHEDPARAM` | Transported; not implemented |
| `0x20` | `POSIX_SPAWN_SETSCHEDULER` | Transported; not implemented |
| `0x40` | `POSIX_SPAWN_USEVFORK` | Transported; not implemented |
| `0x80` | `POSIX_SPAWN_SETSID` | Implemented |

`scripts/check-abi-version.sh` checks the generated TypeScript, public musl
limits header, and private spawn header for freshness. Parser, host, and libc
tests also assert the formula and boundary behavior. The static scratch
contract checks that generated TypeScript values match the public musl limits
header and private spawn header, that `limits.h` consumes the generated
platform header, and that the musl build stages both headers before compiling
`sysconf`. Values deliberately classified differently therefore cannot
silently drift.

## Spawn buffer sizing decision

The large-spawn ownership alternatives have different lifetime consequences:

| Design | Ownership and lifetime | Decision |
|---|---|---|
| Fixed 8,417,320-byte worst-case region | Rust owns one bounded allocation, so it is capacity-safe, but the complete protocol ceiling is retained after the first large use even when ordinary large spawns are much smaller | Not selected for ABI 43 |
| Reusable growable Rust region, `SpawnScratchBuffer` | Rust grows a `Vec<u8>` only while no reservation is active. A fresh token exposes one pointer/capacity pair, commit or cancellation revokes it, and later growth cannot invalidate a live host view. The allocation is leak-free and retains only its kernel-lifetime high-water capacity | Selected |
| Geometric host allocations | The host would have to retain or leak old Rust allocations to keep stale views from becoming dangling, and it would become the de facto allocation owner | Rejected |

The selected growable design follows from ownership, exclusion, and lifetime
correctness. This audit does not present before/after retained-memory, Node,
browser, or timing results. If the PR makes a memory or performance claim, the
external exact-head ledger must contain the performance guide's matching
measurements and artifact fingerprints.

## Conformance storage ownership

The conformance suites must exercise the same append and inode-ownership rules
as ordinary guests. Pointing them at the checkout through raw
`NodePlatformIO`, then weakening exact append for one failing test, would be a
test-specific exception and would conceal the real externally mutable backing.
Instead, the generic Node boot contract may copy a quiescent source tree into a
strict descendant of an existing per-boot scratch mount. It authenticates the
root image first, copies regular files and directories into unpublished staging
paths without preserving hardlink aliases, rejects symlinks and special files,
then renames the complete trees before constructing the branded scratch
backends or publishing readiness. Guest writes never reach the source tree.

Libc and Open POSIX tests use the canonical root image and `/tmp`; the initial
program crosses as an immutable value, and its exact self-exec alias resolves
only to those cached bytes. Explicit runner-provided tools use a pre-VFS worker
capability, so a same-named lazy root-image stub cannot start an ambient fetch
before the capability is considered. Resolver-owned immutable generations use
`execPrograms`; direct checkout or build outputs are copied during
`NodeKernelHost.init` and cross as worker-lifetime `execProgramBytes`. Every
execution receives a fresh copy of those retained exact bytes, so later source
replacement cannot change either sequential or asynchronous resolution. In
isolated mode the main-thread `onResolveExec` fallback serves only the immutable
self-exec alias and otherwise returns no program. Each Sortix invocation stages
only its executable, source file when present, and shared object when present as
regular files in a private fixture, then launches the worker-owned VFS path. The
suite/parent layout remains intact for tests that open `..`, inspect their
source, load a shared object, or exec/spawn themselves. Parallel invocations
receive separate session copies. This is lifecycle ownership rather than a test
allowlist.

## ABI decision

`ABI_VERSION` is 43 in the post-retarget implementation:

- Generated spawn wire values and accepted limits remain byte-for-byte
  identical. Moving those constants to the existing generation path would not
  require a bump by itself.
- `kernel_handle_channel` now accepts the complete channel capacity as its
  second argument and rejects any value other than the canonical allocation
  size. Its signature changes from the ABI-42 two-argument form to
  `(channel_offset, channel_capacity, pid, retry_token)`, so old hosts and
  kernels cannot be mixed. Token zero denotes an initial attempt; a positive
  token authorizes only one exact blocked operation and stable Rust-owned
  target.
- The existing 72-byte channel header's former reserved `u32` at offset 68 is
  generated `request_flags`. Libc writes the generated cancellation-point and
  wake-allowed bits before `PENDING`; plain calls write zero. The host captures
  and clears the word once, rejects unknown combinations, and freezes it with
  the immutable request rather than rereading a reused mailbox. Assigning these
  semantics without moving later fields is still a channel-contract change
  recorded in the ABI snapshot. It is folded into unpublished ABI 43, never a
  second ABI 44.
- ABI 43 requires
  `kernel_blocking_retry_token(pid, tid, syscall_nr)` and
  `kernel_blocking_retry_release(pid, tid, token)`, and adds the trailing retry
  token to `kernel_transfer_io_execute`,
  `kernel_transfer_channel_execute`, `kernel_sendmsg`, and `kernel_recvmsg`.
  The immutable TypeScript snapshot is internal, but those export signatures,
  required capabilities, and close/reuse semantics are incompatible ABI
  contracts. They are part of this worktree's ABI-43 reconciliation rather
  than a second ABI-44 epoch; that decision would not justify changing an
  already released ABI 43 in place.
- The process-channel signal area is one generated 56-byte delivery record for
  both caller widths, replacing the ABI-42 44-byte delivery payload inside a
  48-byte reserved channel area. It carries raw eight-byte `si_value` bits,
  `si_code`, source metadata, and the alternate-stack fields. The C trampoline copies only
  the generated target-native `union sigval` width when constructing
  `siginfo_t`, so wasm32 observes the low four bytes and wasm64 observes all
  eight. This changes the process-channel layout and handler-visible metadata,
  so it is an incompatible ABI change rather than generated bookkeeping.
- `kernel_dequeue_signal` changes from
  `(pid, tid, out_ptr)` to `(pid, tid, out_ptr, out_capacity)` and accepts
  exactly the generated 56-byte capacity. `kernel_mq_drain_notification`
  changes from `(out_ptr)` to `(out_ptr, out_capacity)` and accepts exactly the
  eight-byte wake-record capacity. Old hosts cannot safely call either new
  export, and new hosts fail closed rather than interpreting a negative mqueue
  errno as a pending record.
- `kernel_wait_child_poll` changes from the ABI-42 six-argument form
  `(parent_pid, caller_tid, target_pid, event_mask, flags, out_ptr)` to a
  seven-argument form with `out_capacity`. It accepts exactly
  `KERNEL_WAIT_RESULT_SIZE` (160 bytes), rejects pointer zero with `EFAULT`,
  and rejects every nonexact capacity with `EINVAL` before validating the
  task or selecting a waitable child. The export-signature and child-state
  consumption boundary are incompatible ABI changes covered by ABI 43.
- Host-driven normal exit now calls the required returning
  `kernel_commit_process_exit(status)` export. Rust commits the same
  authoritative cleanup/state transition as guest `_exit`, then returns the
  low eight status bits. The host verifies that return and
  `PROCESS_STATE_EXITED` before publishing callbacks. Calling the
  intentionally trapping guest `kernel_exit` export would make expected
  success indistinguishable from an incoherent export trap, so this concrete
  export addition is ABI-43 work; the lexical TypeScript entry-context shape
  alone is not.
- Generated pointer descriptors now classify every argument as exactly one of
  required or nullable, positive-extent null handling follows that explicit
  classification, and zero-length `Arg` buffers use a canonical owned empty
  range. `prctl` is removed from generic pointer metadata and validated by
  option: only its two name operations use a required 16-byte buffer. These
  pointer interpretations are incompatible semantic marshalling changes, not
  generated-file bookkeeping.
- The large-spawn host/kernel contract is incompatible. The old
  pointer-returning reserve/fixed-fallback model is replaced with required
  begin, pointer, capacity, cancel, and token-consuming commit exports.
- Public `WasmPosixKernel.setsockopt` now stages its four-byte scalar in
  allocator-owned scratch and calls the already existing five-argument
  `kernel_setsockopt` signature. The old four-argument wrapper was incorrect,
  but this correction changes no export signature or accepted guest limit.
  The static compiler audit's generated-export default-deny set is likewise
  host-side enforcement, so neither creates an ABI epoch beyond 43.
- Scalar and vector I/O above the ordinary channel uses the required
  `kernel_transfer_scratch_begin`, `kernel_transfer_scratch_pointer`,
  `kernel_transfer_scratch_capacity`, `kernel_transfer_scratch_cancel`, and
  `kernel_transfer_io_execute` exports. The removed `kernel_read`,
  `kernel_write`, `kernel_pread`, `kernel_pwrite`, `kernel_readv`,
  `kernel_writev`, `kernel_preadv`, `kernel_pwritev`, and
  `kernel_prepare_write_operation` exports carried bare pointers or prepared a
  later bare-pointer operation without carrying allocation capacity. They are
  not an ABI-43 compatibility surface.
- Host-backed positioned I/O requires the new kernel-Wasm imports
  `env.host_pread` and `env.host_pwrite`. They preserve the exact signed-i64
  offset and replace seek/read-or-write/restore. The ABI snapshot does not
  encode kernel imports, so a built-Wasm import test enforces this requirement.
- The host-adapter manifest continues to require `kernel_spawn_process` and
  now also requires `kernel_blocking_retry_release`,
  `kernel_blocking_retry_token`, `kernel_commit_process_exit`,
  `kernel_get_socket_timeout_ms`, `kernel_is_fd_nonblock`,
  `kernel_pick_signal_target_tid`, `kernel_thread_has_deliverable`,
  `kernel_spawn_reserved_process`,
  `kernel_process_metadata_begin`, `kernel_process_metadata_cancel`,
  `kernel_process_metadata_commit`, `kernel_process_metadata_stage`,
  `kernel_set_cwd`,
  `kernel_spawn_scratch_begin`, `kernel_spawn_scratch_pointer`,
  `kernel_spawn_scratch_capacity`,
  `kernel_spawn_scratch_retained_capacity`, `kernel_spawn_scratch_cancel`,
  `kernel_transfer_scratch_begin`, `kernel_transfer_scratch_pointer`,
  `kernel_transfer_scratch_capacity`, `kernel_transfer_scratch_cancel`,
  `kernel_transfer_channel_execute`, `kernel_transfer_io_execute`,
  `kernel_msqid_ds_bytes`, `kernel_semid_ds_bytes`,
  `kernel_semctl_array_bytes`, and `kernel_shmid_ds_bytes`. A same-version
  kernel missing them fails loudly rather than entering a legacy path. The
  policy queries are required because nonblocking/timeout state and signal
  target/deliverability are Rust-owned; a missing export must not fall back to
  a host guess.
- The three `*_ds_bytes(process_pointer_width)` exports and the host-private
  sixth dispatch slot make the caller's wasm32/wasm64 data model authoritative
  for `msqid_ds` (96/120 bytes), `semid_ds` (72/88), and `shmid_ds` (88/112).
  Semaphore GETALL/SETALL use the separate
  permission-aware exact-size export; there is no read-only `IPC_STAT`
  compatibility fallback.
- `KernelScratchRegion` remains an internal TypeScript value, but that fact
  does not neutralize the required export and synchronization changes.
- `NodeKernelHost.sessionSeedTrees`, `execProgramBytes`, and their
  main-thread/worker initialization fields are optional Node configuration.
  They change no Wasm export, import, syscall layout, pointer interpretation,
  required adapter capability, or accepted guest limit. They therefore require
  no epoch beyond the already unpublished ABI 43.

PR #1097 merged as
`c7d039794a43788acfa0b0aea30a700c257f57cb` with ABI 42. Retargeting is
complete, so ABI 43 is the decided epoch for these incompatible changes. The
current Rust source declares ABI 43 and the complete required-export set.
Generated TypeScript, the ABI classifier, and the snapshot must be regenerated
and pass in check mode on the exact PR head named by the external validation
ledger; this documentation-only finalization does not claim their freshness.

## Validation boundary for finalization

This tracked audit is a source and coverage contract, not a mutable execution
log. This documentation-only finalization runs only document-local checks and
does not claim:

- a Node runtime result;
- real Chromium behavior;
- retained-memory or performance measurements;
- a complete build;
- generated-file or ABI snapshot freshness; or
- libc, Open POSIX, or Sortix conformance results.

Before the change is presented as ready, the draft PR's external ledger must
name the frozen exact commit and record, through `scripts/dev-shell.sh`, the
focused scratch and immutable-retry regressions, kernel parser and lifecycle unit
tests, wasm32/wasm64 paths, complete Sortix spawn surface, generated-file and
ABI snapshot checks, and the broader conformance suites required by the
validation guide. Shared runtime behavior requires both Node and real Chromium
evidence. A retained-memory or performance statement additionally requires the
performance guide's matching before/after Node and browser measurements.

No PR is merged by this document. Brandon's explicit approval remains required
after the exact head and its validation ledger are ready.
