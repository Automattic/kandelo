# Kernel Scratch Transfer Audit

Status: this audit began on exact PR #1094 head
`6d923c6454dd7174082f25c3d3991d03f86f5ddb`; that historical evidence is
preserved below. PR #1094 closed without merging. Its main-first replacement,
PR #1097, merged as
`c7d039794a43788acfa0b0aea30a700c257f57cb`, and this branch has been
retargeted to that merge result. PR #1097 shipped ABI 42; the incompatible
export changes documented here intentionally use ABI 43. The pre-retarget and
dirty-worktree results below remain historical or interim evidence, not a
readiness claim. Because recording a commit's own SHA in a tracked document
would change that SHA, the mutable exact-PR-head validation ledger belongs in
the draft PR description after the head is frozen. Brandon's approval must be
requested only when that ledger names the current head and its exact results.

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
pending** record the pre-freeze audit state and mean **Safe in current source**
for the safety disposition; they do not make an exact-head validation claim.
The draft PR's exact-head ledger supersedes those mutable status labels only
when it names the current commit. Historical and interim commands later in
this document never substitute for that ledger.

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
  every direct or aliased factory call and admits only the five exact
  kernel-export-backed production sites.
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

`WasmPosixKernel.getMemory/getInstance` and
`CentralizedKernelWorker.getKernel/getKernelInstance` remain explicit unsafe
trusted-embedder/debug escape hatches. A downstream embedder can use them to
call a pointer-returning export and mutate arbitrary kernel memory, so neither
the type nor the repository audit claims to protect that external code. They
are not used for repository-owned runtime transfers. Their API documentation
warns that direct mutation is outside the checked contract; narrowing or
removing these long-standing low-level APIs would be a separate public-host
API decision.

`host/test/support/wasm-memory-write-audit.ts` and
`host/test/kernel-scratch-contract.test.ts` form the static contract. The
TypeScript compiler and type checker discover production JavaScript,
TypeScript, and selected diagnostic sources recursively, seed their ownership
roots, and propagate kernel-memory ownership through aliases, helper parameters
and returns, spreads, destructuring, logical/comma expressions, loop bindings,
and common intrinsic array element/callback methods. Kernel instance/export
namespace ownership is followed through `getInstance().exports.memory`, not
only the sibling `getMemory()` escape. Typed-array receiver methods use a
positive non-retaining whitelist; callback container arguments and retained
iterators remain visible to the analysis. They report raw
typed/DataView construction, scalar and bulk writes, escapes, persistent
stores, returned views, allocator calls, scratch-region factory calls, and
spawn-reservation calls. The manually reviewed
`KERNEL_SCRATCH_EXPORT_NAMES` capability list supplies the pointer-export
contract. It is not a fail-closed classification of every present or future
kernel export: a newly named direct export omitted from that list would not be
recognized by the pointer-export finding alone. Listed exports and
computed/unknown export access are tracked through direct members,
destructuring, aliases, `call`/`apply`/`bind`, and `Reflect.apply`; invoking or
escaping them outside `KernelScratchLease.invokeKernelExport` is a contract
finding even when every argument is an untainted primitive. Independently,
the ownership audit still rejects any repository-owned raw kernel-memory
view/write and any unreviewed allocator, reservation, or region-factory call.
That independent fail-closed check is the future direct-variable-write
contract. The narrow exact pointer-export allowances are scalar/no-pointer
manifest, ABI, IPC-size, and ioctl queries plus the scratch core's captured
arity inspection. Token-only reserved spawn is not classified as a
pointer-bearing export. A separate exact multiset allowlist admits only named
reviewed occurrences with inline reasons;
adding or duplicating an occurrence fails, and deleting one makes its allowance
stale
and also fails. Framebuffer, process-memory, Rust-lent, and explicit
shared-backing roots remain separately classified because their owner is not
the kernel scratch allocator. A `.set` or `.decode` call counts as a
synchronous reader only when TypeScript resolves it to the native typed-array
or `TextDecoder` declaration; a same-named custom method remains an escape.
JavaScript-family sources have one additional narrow syntax backstop:
zero-argument `.getMemory()` and `.getInstance()` calls are treated as the
documented raw kernel-memory authorities even when an untyped receiver prevents
the checker from recovering its class. The normal ownership analysis then
follows those values
through aliases and helper parameters into raw typed-array or `DataView`
writes. An unrelated JavaScript API with the same spelling requires an exact
site allowance; no file is excluded to suppress it.
This is a compiler-backed contract over the reviewed repository source, not a
claim of a sound general-purpose JavaScript taint analysis or control over raw
writes performed by a downstream consumer through the unsafe trusted-embedder
accessors.

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

## Allocation inventory

The last column records current source safety and a coverage pointer only; it
does not record validation readiness. Reviewed exclusions are outside this
abstraction because they have a different owner or lifetime, not because they
are assumed safe. Mutable exact-head validation status is recorded in the
draft PR ledger, independently of these source-safety rows.

| Region and symbols | Allocating owner; pointer/capacity | Maximum accepted source | Lifetime and overlap | Hosts / widths | Historical audited-head finding | Current safety disposition and coverage notes |
|---|---|---|---|---|---|---|
| Raw allocator boundary, `crates/kernel/src/wasm_api.rs::kernel_alloc_scratch`; `crates/kernel/src/scratch_alloc.rs::layout` | Rust global allocator; successful pointer owns exactly the validated `Layout` size | The export accepts a `u32` request, but a successful allocation is further bounded by the aligned Rust `Layout`/`isize::MAX` domain | Allocation is retained for the kernel lifetime; no host-side free or growth workaround | Node/browser; wasm32/64 kernel | **Unsafe failure boundary.** Invalid `Layout` construction could trap instead of reporting allocation failure | **Implemented; validation pending.** Zero/invalid layouts and allocator-null return zero; the host rejects an invalid zero or out-of-memory-range result before constructing a region |
| Main syscall scratch, `CentralizedKernelWorker.scratchRegion` | Rust `kernel_alloc_scratch`; `KernelScratchRegion`, 65,608 bytes (`CH_TOTAL_SIZE`) | Each layout is checked against the region; ordinary data payload is at most 65,536 bytes (`CH_DATA_SIZE`) | Kernel lifetime; one synchronous lease per dispatch/copy; nested leases fail | Node and browser; wasm32/64 kernel | **Unsafe contract.** Bare `scratchOffset`; several live overflows | **Implemented; validation pending.** All allocator-owned access is lease-mediated |
| TCP/pipe scratch, `tcpScratchRegion`, `requireTcpScratchRegion` | Rust `kernel_alloc_scratch`; `KernelScratchRegion`, 65,536 bytes | One checked network/pipe chunk, at most 65,536 bytes | Kernel lifetime; worker callbacks/messages detach bytes before yielding | Node/browser; wasm32/64 kernel | **Safe sizes, weak contract.** Private pointer reached other code | **Implemented; validation pending.** Region stays private and all access is synchronously leased |
| Large spawn scratch, `beginLargeSpawnScratch`, `SpawnScratchBuffer` | Rust `Vec<u8>` through required `kernel_spawn_scratch_begin/pointer/capacity/cancel`; the returned token gates both pointer and capacity, while separate pointer-free retained-capacity telemetry grants no write authority | Complete blob at most 8,417,320 bytes; ordinary blobs use main scratch | Kernel-lifetime high-water allocation, but a fresh exclusive token and single-use host region per operation. Begin and queries are nonblocking; begin may move only while idle. After every successful begin, host cleanup runs in `finally`. Commit/cancel wait on the same no-import lock and return with a definitive token state; cleanup failure is fatal and leaves the host reentry guard closed | Node/browser; wasm32/64 kernel | **Safe after #1094, weak contract.** Fixed 8,417,320-byte allocation retained after first large use | **Safe in current source.** `kernel_spawn_reserved_process` accepts token+length rather than a bare pointer, with no ABI-42 fallback. The focused Node/Chromium sizing measurements are historical pre-retarget evidence; the frozen final-head rerun remains pending |
| Audio drain, `WasmPosixKernel.audioScratchRegion` | Rust `kernel_alloc_scratch`; 65,536-byte `KernelScratchRegion` bound to the exact Wasm instance and memory that allocated it | `min(out.byteLength, capacity)` and checked Rust return count | One kernel-wrapper generation; one synchronous drain lease. `init` and `initWithMemory` are mutually exclusive one-shot entry points, so a cached region cannot survive an instance replacement | Node/browser; wasm32/64 kernel | **Confirmed unsafe/uncertain.** Pointer/range and producer count were incomplete, and a later second initialization could leave the cached region bound to the old generation | **Safe in current source.** Allocation, requested bytes, current range, returned count, and one-generation lifetime are checked |
| Public wrapper temporary storage, `apiScratchRegion` | Rust `kernel_alloc_scratch`; 65,536-byte `KernelScratchRegion` bound to one exact kernel generation | Each socket/poll/terminal/ioctl/uname/pipe/rusage/select request must fit | One kernel-wrapper generation; synchronous public-call lease. Concurrent or post-success initialization rejects before state mutation; a failed first attempt clears partial state and remains retryable | Node/browser; wasm32/64 kernel | **Confirmed unsafe.** Hard-coded addresses 4 and 16 were not allocations, and later reinitialization could pair an old cached region with a new memory/instance | **Safe in current source.** All temporary public API storage is allocator-owned and cannot outlive its generation |
| Rust-lent host-import destinations, `checkedWasmImportMemoryRange`, `readKernelBytes`, `writeKernelBytes` | Rust slice/local/struct; pointer plus explicit capacity, or a generated authoritative fixed-format size such as the 68-byte KMS mode record, for one import call | Genuine producer span no larger than the Rust-supplied or generated capacity | Only the synchronous import; backend data is staged in host-owned memory and no kernel view is lent or retained | Node/browser; wasm32/64 kernel | **Valid ownership, incomplete checks.** Lossy conversions, live-view lending, and clamping writes existed | **Implemented; validation pending.** Signed-wasm32/wasm64 pointer normalization, complete range, intrinsic producer span, detached/staged backend I/O, and producer/result length precede one publish |
| Unsafe trusted-embedder accessors, `WasmPosixKernel::{getMemory,getInstance}` and `CentralizedKernelWorker::{getKernel,getKernelInstance}` | Exposes the complete raw kernel memory/instance, not a capacity-bearing allocation | Unrestricted by design; consumers are trusted to uphold the kernel ABI | Repository transfer code does not use this path; external direct mutation has no lease or overlap guarantee | Node/browser; wasm32/64 kernel | Existing public low-level/debug API | **Reviewed out-of-contract boundary.** Explicitly documented as unsafe; the static repository audit does not claim to control downstream raw-memory writes |

## Transfer inventory

“Synchronous” below means that no promise, worker-message yield, or callback
boundary can occur while Rust is expected to consume the staged bytes.
Single-threaded event-loop execution is not used as a substitute for capacity
or range validation. The last column records current source safety and coverage
only. Its mutable exact-head validation status is recorded in the draft PR
ledger.

| File / exact symbols | Owner; pointer and declared capacity | Maximum accepted source and origin | Capacity, range, and pointer proof | Synchronous use / overlap | Hosts / widths | Historical audited-head finding | Current safety disposition and coverage notes |
|---|---|---|---|---|---|---|---|
| `host/src/kernel-worker.ts::pollWaitableChild`; `crates/kernel/src/wasm_api.rs::kernel_wait_child_poll`; `crates/shared/src/lib.rs::{KernelWaitResult,KERNEL_WAIT_RESULT_SIZE}` | Rust main allocation; one `KernelScratchLease` lends `STRUCT_SIZE_KERNEL_WAIT_RESULT` bytes (160) and passes the same explicit capacity to Rust | Exactly one fixed 160-byte wait-result record generated from the shared `KernelWaitResult` layout | The lease proves allocator ownership, allocation capacity, current-memory bounds, and lossless kernel-width conversion. Rust rejects pointer zero with `EFAULT` and every capacity other than 160 with `EINVAL` before task validation or waitable-child selection | One synchronous poll and detached decode inside the lease. Rejected output ranges cannot select or consume the sole event; a successful non-`WNOWAIT` call publishes the complete record and reaps atomically | Node/browser shared path; kernel wasm32/64. The shipped real-Wasm regression executes wasm32, and host mocks exercise bigint pointer handling | **Unsafe ABI-42 contract.** The export accepted a bare result pointer, so the host/Rust boundary could not prove that 160 writable bytes belonged to the allocation before selecting the child event | **Safe in current source.** The real-Wasm regression covers pointer zero, capacities 159/160/161, canaries, rejected-call non-consumption, exact-capacity reap, and the following `ECHILD` result |
| `host/src/kernel.ts::{intrinsicBufferSourceSpan,bufferSourceToArrayBuffer,init,initWithMemory,initialize}` | Caller supplies kernel module bytes; the host immediately owns one detached `ArrayBuffer` snapshot, then publishes one exact instance/memory generation | Exact intrinsic `ArrayBuffer`, typed-array, or `DataView` byte window accepted by the WebAssembly compiler | Captured native internal-slot getters reject non-genuine/detached sources and ignore subclass span getters; pointer-width detection and compilation consume the same snapshot. An explicit initialization state rejects a concurrent or post-success initializer before it mutates width, memory, instance, or cached scratch authority | Snapshot completes before the asynchronous compile; later caller mutation cannot replace either consumer's bytes. A failed first instantiation clears partial state and permits one clean retry; a successful wrapper is one-shot | Node/browser; kernel wasm32/64 | **Confirmed pointer-width and generation-lifetime defects.** A view subclass could make width detection parse decoy bytes while the engine compiled its intrinsic bytes; a second init could leave cached scratch authorized against the old instance | **Safe in current source.** Spoofed-input, wasm32/wasm64 cached public/audio scratch, rejected reinit, concurrent init, and failed-init retry regressions cover the contract |
| `host/src/kernel-worker.ts::replaceProcessMetadata` | Rust main allocation; private `scratchRegion`, 65,608 bytes; payload begins at `CH_DATA` | One metadata entry at most `CH_DATA_SIZE` (65,536); exec argv/environment aggregate at most generated `ARG_MAX` | Detached caller bytes; lease proves owned allocation and current memory; Rust return count is bounded | One lease and Rust call per entry; view is reacquired after possible growth; no overlap | Node/browser; kernel and guest wasm32/64 | Sizes fit, but a bare pointer represented ownership | **Implemented; validation pending.** Lease-mediated staging |
| `host/src/kernel-worker.ts::{handleExec,handleExecveat,readExecPathFromProcess,readStringArrayFromProcess,resolveExecPathAgainstCwd,checkedScratchProducerByteLength}` | Exec pathname/argv/environment are detached JS strings read from caller process memory; only CWD/fd-path queries use the 65,608-byte main allocation | Path scan is bounded by generated `PATH_MAX` 4,096; each string by 65,536; complete argv/environment representation, including pointers and NULs, by generated `ARG_MAX` 4 MiB; CWD/fd-path output by 4,096 | Native pointer-array entries are read at guest width and wasm64 values must be losslessly representable; every string must terminate in its caller range; each direct `withLease` query passes exact pointer/capacity, validates Rust's count with `checkedScratchProducerByteLength`, and detaches with `copyOut` before releasing the lease | No scratch view crosses `callbacks.onExec`'s promise; only detached strings/arrays do. Each CWD/fd-path query completes its lease before the callback | Node/browser; guest wasm32/64 independent of kernel width | **Unsafe/uncertain edge.** Async exec and bounded-string paths used bare scratch queries and lossy/incomplete pointer scans | **Implemented; validation pending.** Explicit `PATH_MAX`/`ARG_MAX`, lossless native-pointer, checked producer count, and no-view-across-promise contract |
| `host/src/kernel-worker.ts::{ptyMasterWrite,ptyMasterRead}` | Rust main allocation, full 65,608-byte region | Write chunks are `min(remaining, lease.capacity)`; read request is `min(4,096, lease.capacity)` | Write source slice and destination are independently checked; returned write/read count must be a safe integer no larger than the offered chunk/request | One lease per chunk/call; read bytes are detached before `drainPtyOutput`; a second operation cannot enter the active lease | Node/browser; kernel wasm32/64 | **Confirmed unsafe.** `ptyMasterWrite` copied arbitrary `data.length` into the allocation; read trusted the producer count | **Implemented; validation pending.** Exact 65,608 and 65,609 regression |
| `host/src/kernel-worker.ts::setCwd` | Rust main allocation, 65,608 bytes | Encoded path must be shorter than generated `POSIX_PATH_MAX_BYTES` (4,096, including the NUL contract) | Length is rejected before acquiring/copying; lease then proves allocation and current-memory bounds | One synchronous lease and `kernel_set_cwd` call; no retained view | Node/browser; kernel wasm32/64 | **Confirmed unsafe.** Copy happened before Rust's `PATH_MAX` rejection | **Implemented; validation pending.** Pre-copy oversized-CWD regression |
| `host/src/kernel-worker.ts::{enumProcs,readProcMaps,checkedScratchProducerByteLength}`; Rust exports `kernel_get_cwd`, `kernel_get_fd_path`, and wait/wake/mqueue query helpers | Rust main allocation, 65,608 bytes | Fixed or explicit producer requests, presently no more than 4,096 bytes for paths and 1,280 bytes for listed fixed records | Requested capacity is passed to Rust; returned byte/count value must be safe and fit that capacity before the same lease calls `copyOut` | Producer runs inside one direct checked lease; detached bytes cross any callback/retry boundary | Node/browser; kernel/guest wasm32/64 | Fixed requests fit; several producer counts were trusted | **Implemented; validation pending.** Inline checked leases and `checkedScratchProducerByteLength` replace the removed aggregate helper |
| `host/src/kernel-worker.ts::CentralizedKernelWorker::_handleSyscallInner`; `host/src/generated/abi.ts::SYSCALL_ARGS`; `crates/shared/src/host_abi.rs::{SyscallArgDesc,SyscallArgSize}`; `crates/kernel/src/channel_scratch.rs::{ChannelScratchRegion,validate_channel_scratch_arguments,validate_prctl_layout,checked_cstr_len}`; `crates/kernel/src/wasm_api.rs::dispatch_channel_syscall` | Rust main allocation; channel is 72 bytes and data capacity is exactly 65,536; `kernel_handle_channel(offset, capacity, pid)` carries that complete capacity through dispatch | Sum of all descriptor-sized arguments, including alignment, must fit `CH_DATA_SIZE`; every pointer descriptor is explicitly required or nullable; size expressions originate in generated shared ABI metadata and raw syscall counts; every C string must terminate inside the remaining channel allocation | The host rejects negative, fractional, unsafe-integer, multiplication/addition overflow, positive null unless explicitly nullable, and a non-null `Deref` outer buffer without its length pointer. Null argument-sized zero-length buffers become a non-null owned empty range. All `Deref` lengths are captured before planning, then used for both buffer sizing and staged length independent of descriptor order. Rust verifies canonical pointer order, alignment, non-overlap, allocation bounds, descriptor nullability, and bespoke layouts before a checked pointer can reach dispatch. It also rejects a C-string pointer outside the numeric region or a missing in-region NUL; pathname exports separately retain generated `PATH_MAX` semantics. `prctl` uses an option-sensitive validator: name operations receive one exact required 16-byte range and scalar options receive no scratch pointer | Planning retains host-owned copies only; one lease stages, dispatches, detaches output inline in `_handleSyscallInner`, and releases; nested or promise-escaping lease use fails. Rust recomputes a dynamic range from the staged length but cannot reconstruct a separate unpadded host capacity within one alignment bucket because the wire does not encode one; the pre-captured host value under this lease remains the exact-capacity authority | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe/uncertain domain edges.** Some raw pointers bypassed descriptors, fixed outputs such as `pipe(NULL)` were implicitly treated as nullable, `prctl` scalars were treated as pointers, `Deref` planning could reread mutable lengths, staging was not ownership-bearing, and Rust's bare-pointer scanner used `PATH_MAX` as both an allocation and semantic bound | **Implemented; focused validation passed.** Exact/capacity+1, positive-null and owned-empty, explicit-nullability drift, option-sensitive `prctl`, reordered/mutated `Deref`, exact raw-process-address allowlist, bounded C-string EFAULT, and non-path strings above `PATH_MAX` |
| `host/src/kernel-worker.ts::{_handleSyscallInner,completeChannel,handleBlockingRetry,handleSleepDelay}`; `PreparedChannelCompletion` | Output belongs to the just-completed main-scratch lease, but the only state allowed to outlive it is a detached `Uint8Array` plus its already-validated process destination | Exactly the output descriptors and successful byte counts detached inline in `_handleSyscallInner` before lease release; error and interrupted completions publish no staged output | `completeChannel` has no scratch-read fallback. Retry, timeout, stopped-process, signal, and teardown state accept only explicit detached writes; absent output means an empty list | Detachment occurs synchronously in the dispatch lease; later callbacks may overlap another scratch use without observing its bytes | Node/browser; guest/kernel wasm32/64 | **Confirmed lifetime defect.** Deferred completion could reread the shared allocation after another operation replaced it | **Implemented; validation pending.** Immediate-timeout poll, EAGAIN `recvmsg`, interrupted sleep, and stale-scratch regressions |
| `host/src/kernel-worker.ts::{PreparedChannelCompletion.deferredClone,failDeferredCloneLaunch}` | Caller process mailbox, not kernel scratch; the original four-byte parent-TID destination is validated and retained as a scalar | Exactly one `pid_t` word when the original clone requested `CLONE_PARENT_SETTID` | Rollback uses the captured `parentTidPointer`; it never rereads mutable flags or a replacement pointer from a parked mailbox | Parked completion may span worker construction and stop/continue callbacks, but retains no process or scratch view | Node/browser; guest wasm32/64 | **Confirmed deferred-lifetime defect.** Failure rollback reread mutable mailbox metadata and could clear a replacement address | **Implemented; validation pending.** Mailbox-replacement regression proves only the original word is cleared |
| `crates/shared/src/process_layout.rs`; `crates/shared/src/host_abi.rs::SyscallArgSize::ProcessLayout`; `crates/kernel/src/process_wire.rs::{read_*,write_*}` | Main data capacity 65,536; exact width-selected native record is the capacity passed to Rust | `stack_t` 12/24, kernel-facing `itimerval` 16/32, `mq_attr` 32/64, `sigevent` 64/64, `statfs` 88/120, `sysinfo` 312/368, and `siginfo_t` 128/128 | Host selects by guest pointer width in private slot 5, validates the full caller range, and stages exactly that size; Rust rejects widths other than 4/8 and non-exact slices; output padding/reserved bytes are zeroed | One dispatch lease; Rust serializes into the complete lent slice before copy-back | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe mixed-width/native-layout contract.** Fixed wasm32 or partial records truncated wasm64/full native records; stale `sysinfo` syscall 208 conflicted with musl 269 | **Safe in current source.** Historical C-layout and Rust boundary coverage plus the current dirty-tree Node and real-Chromium wasm32/wasm64 process-native fixtures pass; the exact-final-head rerun remains pending |
| `host/src/kernel-worker.ts::dequeueSignalForDelivery`; `crates/kernel/src/wasm_api.rs::kernel_dequeue_signal`; `crates/kernel/src/process_wire.rs::{validate_signal_delivery_output,encode_signal_delivery_record}`; `libc/glue/channel_syscall.c` signal delivery | Rust main allocation; `KernelScratchLease.exportPointer(CH_SIG_BASE, 56)` lends exactly the generated 56-byte signal-delivery record and passes capacity 56 separately | Exactly one generated signal record: signum, handler, flags, raw eight-byte `si_value`, saved mask, `si_code`, two sender/timer metadata words, and alternate-stack pointer/size | The host lease proves the owned allocation and current-memory range; Rust rejects null and any capacity other than 56 before writing. Rust first encodes all 56 bytes into an owned array, then publishes once. The host detaches all 56 bytes before releasing the lease and copies them to the process channel only after a nonnegative result | One synchronous lease per dequeue; the detached record is published only after the lease ends, so a wake or second channel cannot observe partially replaced scratch bytes. The C trampoline reconstructs a native `siginfo_t` and copies only the target-width `union sigval` bytes: four for wasm32 and eight for wasm64 | Node/browser; kernel wasm32/64 and guest wasm32/64 | **Weak capacity and metadata contract.** The old export accepted only a bare output pointer, and its 44-byte payload inside a 48-byte reserved channel area did not carry complete `si_value`, sender/timer metadata, or one authoritative delivery size | **Implemented; focused Node and real-Chromium validation passed on the current dirty tree.** Rust exact-capacity/serialization tests and the rebuilt real-musl process-native fixture cover 56-byte delivery, `SA_SIGINFO`, sender metadata, and target-width C reconstruction on wasm32 and wasm64; the exact-final-head rerun remains pending |
| `host/src/kernel-worker.ts::drainMqueueNotification`; `crates/kernel/src/wasm_api.rs::{queue_mqueue_signal_notification,kernel_mq_drain_notification}`; `crates/kernel/src/mqueue.rs::mq_notify` | Rust main allocation; one leased pointer plus explicit capacity 8 for the wake-only `{ pid: u32, signo: u32 }` record. The full notification value remains in Rust's signal queue rather than this scratch record | At most one eight-byte wake record. `mq_notify(SIGEV_SIGNAL)` accepts only signums satisfying `1 <= signo < NSIG`; zero, `NSIG`, and a negative native value represented as `u32::MAX` are rejected before registration | The lease proves the owned allocation/current memory and Rust requires capacity 8 before writing. The host accepts only safe-integer results 0 or 1; a negative errno, fractional/unsafe value, or value above 1 fails closed before unchanged reusable bytes can be decoded. Rust queues raw eight-byte `si_value`, `SI_MESGQ`, sender PID, and UID before publishing the wake record | The eight bytes are detached inside one synchronous lease. The lease is released before wake/signal processing can reenter main scratch. A rejected registration does not occupy the queue's one-shot notification slot | Node/browser; kernel wasm32/64 and guest wasm32/64 | **Weak capacity and error contract.** The old drain export accepted a bare pointer, and a negative errno was truthy in JavaScript and could decode stale scratch as a fabricated notification; invalid signal registrations were not rejected before occupying the slot | **Implemented; focused Node and real-Chromium validation passed on the current dirty tree.** Native tests cover invalid signums without registration and a valid retry; the rebuilt process-native fixture covers `SI_MESGQ` plus full-width value/sender metadata, and the host regressions prove both fail-closed negative-result handling and the real export's null/7/8/9 boundary with exact eight-byte output canaries; the exact-final-head rerun remains pending |
| `crates/shared/src/host_abi.rs` `timer_create` process-layout descriptor; `host/src/kernel-worker.ts::_handleSyscallInner`; `crates/kernel/src/wasm_api.rs::kernel_timer_create`; `crates/kernel/src/process_wire::read_sigevent` | The caller-native 64-byte `sigevent` is staged in the 65,536-byte main data allocation; the timer ID output has its separately described caller and scratch capacity | Null selects the POSIX default; otherwise exactly 64 bytes. `union sigval` contributes four meaningful bytes for a wasm32 caller or eight for wasm64, while the containing native structure remains 64 bytes on both | Generic descriptor planning proves the complete caller range and main-allocation capacity. The private process-pointer-width slot is passed losslessly to `kernel_timer_create`; Rust accepts only width 4 or 8, selects that exact native layout, and preserves the parsed value as raw `u64` bits through timer state and delivery | One synchronous dispatch lease covers staging, parsing, timer creation, and detached timer-ID copy-back. No native view or scratch pointer survives the call | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed mixed-width value defect.** The old export had no caller-width argument and parsed only a partial `sigevent`, so a wasm64 `sival_ptr` could be narrowed | **Implemented; focused native, Node, and real-Chromium validation passed on the current dirty tree.** Exact/short native-layout tests and the rebuilt process-native fixture cover wasm32 low-32-bit and wasm64 full-64-bit timer values; the exact-final-head rerun remains pending |
| `crates/shared/src/host_abi.rs::SyscallArgSize::Fixed`; `crates/kernel/src/process_wire.rs::{write_stat,read_sched_param,write_sched_param}` | Main data capacity 65,536; the fixed native record size is part of the generated syscall descriptor | `stat` 112 bytes and `sched_param` 48 bytes on both supported caller widths | The descriptor proves the complete caller range and exact fixed capacity; these records do not use width selection or private slot 5 | One dispatch lease; Rust consumes or fills the complete fixed slice | Node/browser; guest wasm32/64 | **Confirmed partial-record contract.** Earlier descriptors did not name the complete musl object | **Implemented; validation pending.** Fixed-layout C drift checks and Rust exact/short tests |
| Generated `timerfd_settime`, `timerfd_gettime`, `signalfd`, and `signalfd4` descriptors; Rust checked channel-pointer consumers | Main data allocation; native timer records are 32 bytes and the signal mask is exactly eight bytes | Fixed generated record sizes; nullable old-timer output is the only optional timer pointer | Complete caller range, direction, nullability, allocation capacity/current memory, and Rust channel-pointer checks; the raw caller pointer never enters the kernel namespace | One dispatch lease; all input/output is detached at the normal completion boundary | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed address-domain defect.** Caller pointers were passed as kernel pointers | **Safe in current source.** Historical pre-retarget coverage rebuilt the ABI-43 kernel/host artifacts and passed guarded caller-object cases for wasm32 and wasm64; final-head Node and browser reruns remain pending |
| `crates/shared/src/host_abi.rs` `Getaddrinfo` descriptor; `host/src/kernel-worker.ts::_handleSyscallInner`; `host/src/kernel.ts::hostGetaddrinfo` | Main data allocation; output capacity exactly four bytes, matching musl's private syscall result | Input is a required NUL-terminated name; name plus four-byte output must fit 65,536; host backend result must be exactly/fewer than the lent four bytes | Full caller name and four-byte output ranges; descriptor capacity and current memory; Rust and host import both receive explicit four-byte capacity | One dispatch lease and synchronous host import; four detached bytes are copied back | Node/browser; guest/kernel wasm32/64 | **Confirmed live caller overwrite.** Fixed 256-byte copy-back wrote 252 bytes beyond musl's four-byte result object | **Implemented; validation pending.** Four-byte result plus 252-byte canary regression |
| `host/src/kernel-worker.ts::handleGetgroups`; `crates/kernel/src/wasm_api.rs::kernel_getgroups(size,list_ptr,list_capacity_bytes)` | Rust main allocation; positive request lends one explicit four-byte gid slot; count query lends pointer/capacity zero | Kandelo currently returns exactly one supplementary gid; `size` accepts 0 through `INT_MAX`, but positive size never increases the lent capacity beyond four | Positive caller output range is exactly four bytes; kernel pointer and capacity are staged together; Rust rejects null or capacity below four; returned count must be safe, `<= size`, and `<= 1` | One lease; output is detached before reuse; zero-count query performs no pointer conversion | Node/browser; guest/kernel wasm32/64 | **Confirmed unsafe.** A raw process pointer crossed into the kernel address space and Rust wrote one `u32` without an allocation-capacity contract | **Implemented; validation pending.** Capacity 0/3/4/5, null, count-query, and detached-copy regressions |
| `crates/shared/src/host_abi.rs` `Setgroups` descriptor; `host/src/kernel-worker.ts::_handleSyscallInner` | Rust main data allocation, exactly 65,536 bytes | Count times four bytes; maximum one-call source is 16,384 gids from `CH_DATA_SIZE / sizeof(gid_t)` | Checked integer multiplication, complete caller source, descriptor layout, allocation capacity, current memory; count zero ignores the caller pointer and resolves a checked non-null empty scratch address under the final lease | One dispatch lease; no scratch view survives | Node/browser; guest/kernel wasm32/64 | **Unsafe address-domain contract, not a demonstrated live overwrite.** Bare caller pointer could enter the kernel namespace; current Rust did not dereference it | **Implemented; validation pending.** 16,384/16,385, zero-count high pointer, and positive null regressions |
| `crates/shared/src/ioctl_contract.rs::IOCTL_REQUEST_CONTRACTS`; `host/src/kernel-worker.ts::_handleSyscallInner` ioctl branch; `crates/kernel/src/wasm_api.rs::kernel_ioctl` | Rust main data allocation; pointer requests receive exact request-specific capacity; scalar/no-argument/unknown requests receive no scratch pointer | Pointer sizes are table-selected: 1–160 bytes in the current table, including `termios` 60 and `DRM_IOCTL_VERSION` 36 for wasm32 or 64 for wasm64 | Unsigned request lookup; exact guest-width size/direction; complete caller range; null and one-byte-short rejection; explicit `buf_len`; Rust repeats kind, width, exact length, null, and current-memory checks. `ScalarI32` requests canonicalize only their low 32 transport bits, so unspecified upper wasm64 C-vararg bytes neither become a pointer nor reach Rust. Known width-incompatible pointer requests return `EOVERFLOW` | One dispatch lease; no pointer is manufactured for scalar/no-arg/unknown requests | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe/incorrect.** Generic 256-byte staging/copy-back overran small caller objects and scalar values were treated as pointers; width-specific DRM layout was not represented | **Implemented; generated/runtime validation pending.** FIONREAD four-byte canary, exact 4/36/64, short/null, every scalar request with signed/unsigned and dirty-high-bit inputs, no-arg/unknown, and unsupported-width regressions |
| `host/src/kernel-worker.ts::{checkedNetworkIoctlProcessRange,handleIoctlIfconf,handleIoctlIfname,handleIoctlIfhwaddr,handleIoctlIfaddr,handleIoctlIfindex}` | Caller process memory, not kernel scratch; required outer `ifconf`/`ifreq` and the nested process buffer are caller-owned | Command-specific 8/16-byte `ifconf`, 32/40-byte `ifreq`, and `ifconf.ifc_len`; no shared-table maximum substitutes for the nested length | The shared checked process-range proof rejects a null/short outer object and checks the complete nested output range; the wasm64 nested pointer remains `bigint` until lossless conversion. Only `ifc_buf == 0` after a valid outer structure retains Linux size-query semantics | Synchronous host-side handling; no kernel scratch lease or retained view | Node/browser shared code; guest wasm32/64 | **Confirmed unsafe caller-boundary defect.** The former ad-hoc total-memory check accepted outer address zero, and the nested wasm64 pointer was narrowed before its proof | **Implemented; focused Node validation passed.** Exact and one-byte-short outer/nested ranges, capacity+1 output canaries, every network `ifreq` handler, null outer objects, and high/unsafe wasm64 non-aliasing are included in the current 189-test focused transfer-boundary file; the exact-final-head browser rerun remains pending |
| `host/src/kernel-worker.ts::handleFcntlLock` | Rust main data allocation; 32-byte `struct flock` | Exactly 32 bytes | Full caller range, owned scratch range, current memory | One synchronous lease | Node/browser; guest/kernel wasm32/64 | Fixed size fit, bare pointer | **Implemented; validation pending** |
| `host/src/kernel-worker.ts::{handleSelect,handlePselect6}` | Rust main data allocation; three optional generated 128-byte fd sets plus timeout/mask records | Generated `FD_SETSIZE` 1,024 and `fd_set` size 128; optional eight-byte kernel mask and native timeout inputs | `nfds` is bounded by the generated set width; every optional fd set, timeout, outer pselect sigmask descriptor, and nested mask range is checked before staging | Each attempt is synchronous; retry owns copies/scalars and no scratch view | Node/browser; guest/kernel wasm32/64 | **Confirmed unsafe caller-range paths and duplicated layout constants** | **Implemented; focused Node validation passed.** Select/pselect count/range boundaries use the generated contract |
| `host/src/kernel-worker.ts` generic `ppoll` descriptor planning and retry conversion | Main allocation/channel; 16-byte caller timespec and optional eight-byte signal mask become scalar kernel arguments | Fixed native records from syscall contract | Raw pointers remain bigint until lossless conversion; both complete caller ranges are proved on the first attempt and retry | Only final dispatch lease contains scratch bytes; retry retains scalars, never a view | Node/browser; guest wasm32/64 | **Unsafe/uncertain.** Special pointers were outside generated descriptors | **Implemented; validation pending.** Out-of-range and unrepresentable wasm64 regressions |
| `host/src/kernel-worker.ts::{handleEpollCtl,handleEpollPwait}`; `crates/shared/src/lib.rs::WasmEpollEvent` | Caller process memory for events plus main scratch for the internal poll request; native epoll event is exactly 16 bytes | One `epoll_ctl` event or checked `maxevents * 16`; fields are events at offset 0, zero/ignored pad at 4–7, data at offset 8 | Checked multiplication and complete caller input/output ranges; exact 16-byte records; copy-out explicitly zeroes padding and writes `u64` data at offset 8 | One synchronous attempt; retry/interest state stores values, not process or scratch views | Node/browser; guest wasm32/64 | **Confirmed unsafe caller/output range handling and stale 12-byte assumption** | **Implemented; validation pending.** Exact-end, one-byte-short, padding, and offset-eight regressions |
| `host/src/kernel-worker.ts::{checkedProcessIovecs,kernelIovecFootprint,handleWritev}` | Rust main data allocation; kernel table is 8 bytes per entry and payload follows with four-byte alignment after every entry | Count 1..generated `IOV_MAX` (1,024); full footprint is `8*count + Σ align4(iov_len)` and must be `<= CH_DATA_SIZE` | Native table is 8 bytes/entry on wasm32 or 16 on wasm64; table and every nested source are range-checked losslessly; total is `<= SSIZE_MAX`; result cannot exceed staged payload. Caller linear-memory address zero is valid for a table or data base when the complete positive-length range fits; `{ base: 0, len: 0 }` performs no data access. Positioned offsets remain exact signed `bigint` values across slow chunks | Fast path one lease; slow path sends one checked chunk of at most `CH_DATA_SIZE-8`; no view survives between calls | Node/browser; guest wasm32/64 | **Confirmed live allocation overflow and adjacent offset defect.** Admission omitted per-entry padding and could write 3,072 bytes past the 65,536-byte data area; slow `pwritev` rounded offsets above `Number.MAX_SAFE_INTEGER` | **Implemented; focused Node validation passed.** Exact footprint, address-zero semantics, and exact `2^53+1` slow-path offsets |
| `host/src/kernel-worker.ts::{checkedProcessIovecs,kernelIovecFootprint,handleReadv}` | Rust main data allocation; same 8-byte kernel table/alignment model | Count 1..1,024; table plus requested data must fit 65,536 for fast path; slow chunks reserve the eight-byte table first | Complete native table and every output buffer are checked; returned count must be safe and no larger than offered total; each copy-back uses checked destination capacity. Address zero is caller-owned process memory here, so bounded positive output and zero-length entries may begin there. Positioned offsets remain exact signed `bigint` values across slow chunks | Fast path one lease; slow path one bounded iovec chunk per lease; copy-back bytes are detached | Node/browser; guest wasm32/64 | **Confirmed live allocation overflow and adjacent offset defect.** Fast path subtracted only eight bytes and did not enforce `IOV_MAX`, reaching 8,184 bytes past the data allocation; slow `preadv` rounded offsets above `Number.MAX_SAFE_INTEGER` | **Implemented; focused Node validation passed.** Full-table/count/address-zero and exact `2^53+1` slow-path offset regressions |
| `host/src/kernel-worker.ts::{handleLargeWrite,handleLargeRead}` | Rust main data allocation; one data chunk at most 65,536 bytes | Requested scalar count may be larger, but each scratch transfer is `min(remaining, CH_DATA_SIZE)` | Complete caller source/destination range is proved before the first Rust call; each Rust count is safe and bounded by the offered chunk | One lease per chunk; no view survives | Node/browser; guest/kernel wasm32/64 | Scratch capacity fit; complete caller range was unsafe | **Implemented; validation pending.** Large-I/O source/destination regressions |
| `host/src/kernel-worker.ts::{_handleSyscallInner,handleLargeWrite,handleLargeRead,handleSharedMappingsAfterFileSyscall}` ordinary and large `pread`/`pwrite` | Main scratch for transfer; the positioned file offset is a signed i64 scalar and shared-mapping state has a separate host owner | Ordinary request at most 65,536 bytes; larger requests use checked chunks | The raw channel offset remains `bigint` through ordinary dispatch, large-operation preflight, chunk addition, and kernel argument encoding. Shared-mapping updates use the exact offset only when it is safely indexable; otherwise they refresh from the authoritative file instead of aliasing a rounded JS number | One lease per dispatch/chunk; mapping refresh owns no scratch view | Node/browser; guest wasm32/64 | **Confirmed precision defect adjacent to scratch dispatch.** Ordinary and large `pread`/`pwrite` rounded `2^53+1`, and a rounded shared-map offset could update the wrong page | **Implemented; focused Node validation passed.** Ordinary/large wasm32/wasm64 exact-i64 tests plus shared-map non-aliasing |
| `host/src/kernel-worker.ts::{checkedProcessMessage,nativeControlToKernelWire,kernelMessageLayout,handleSendmsg}`; `crates/kernel/src/socket_wire.rs`; fixed `Kernel{Msghdr,Iovec,Cmsghdr}Wire` | Rust main data allocation; one generated 28-byte fixed header, optional name/control, one generated eight-byte canonical iovec, and flattened payload share exactly 65,536 bytes | Caller-native `msghdr` is generated as 28 bytes on wasm32 or 56 on wasm64; native iovec count 0..generated `IOV_MAX` 1,024; the complete canonical footprint must fit | Full native header/table and every nested range are checked losslessly. Native `cmsghdr` records are validated and translated to a generated 12-byte-header/alignment-4 wire; all caller iovecs are flattened into one owned payload. Rust revalidates the complete canonical ancillary stream and accepts only the zero/one-iovec host wire. Returned count cannot exceed staged data | One synchronous lease covers header/control/flatten/call; only owned parsed metadata exists before it and no view survives | Node/browser; guest wasm32/64 | **Confirmed live allocation overflow plus mixed-width protocol defect.** Count/layout capacity was incomplete, only the first caller iovec reached Rust, and wasm64 ancillary headers were interpreted as wasm32 | **Implemented; focused Node validation passed.** `IOV_MAX+1`, exact/capacity+1 layout, multi-iovec/zero-entry flattening, malformed/wrapped control records, invalid descriptor propagation, sequential reuse, and wasm32/64 native-wire translation |
| `host/src/kernel-worker.ts::{checkedProcessMessage,kernelControlCapacityForRecv,kernelControlToNative,kernelMessageLayout,handleRecvmsg}`; `crates/kernel/src/wasm_api.rs::kernel_recvmsg` | Same fixed-wire main allocation; caller name, native control, and every native iovec destination retain their own separately checked capacities | Native header 28/56; count 0..1,024; one canonical contiguous receive payload plus name and the caller-representable canonical control capacity must fit 65,536 | Complete caller table/destination ranges are proved before dispatch. Canonical ancillary capacity is derived from native data capacity rather than total native header space; returned wire length, alignment, type, and descriptor width are validated before expansion. Payload is detached and scattered across all caller iovecs, skipping zero-length entries; native padding is zeroed. `MSG_TRUNC` may report the full datagram while only the bounded prefix is copied | One synchronous lease snapshots all output; caller publication uses detached arrays after release, and retry/error paths publish nothing | Node/browser; guest wasm32/64 | **Confirmed live allocation overwrite plus mixed-width/first-iovec defects.** Complete count/footprint was unproven, only one destination received bytes, and wasm64 `cmsghdr` capacity could install descriptors that could not be represented on copy-back | **Implemented; focused Node validation passed.** Exact/capacity+1, multi-iovec scatter with a zero middle entry, EAGAIN/no-publish, malformed canonical output, `MSG_CTRUNC`, wasm32/64 capacity matrices, flags, and padding |
| `crates/kernel/src/{pipe.rs,process_table.rs,socket.rs,syscalls.rs,wasm_api.rs}` AF_UNIX `SCM_RIGHTS`; `programs/scm-rights-semantics.c` | Stream ancillary records own retained descriptors at absolute carrier-byte ranges; each datagram queue entry atomically owns payload, source address, and retained descriptors | Generated control-record limits plus the fixed one-record host wire; receiver installation is additionally bounded by the caller control capacity and fd-table capacity | Stream reads cannot observe rights before their carrier bytes and stop `MSG_WAITALL` at a rights boundary. PEEK clones retained references fallibly without consuming them. Datagram enqueue rolls back all retained references if publication fails. Zero-iovec receive can consume a zero-byte datagram and its rights, while ordinary `read(...,0)` consumes nothing. Output `MSG_TRUNC`, input `MSG_TRUNC`, `MSG_CTRUNC`, and `MSG_CMSG_CLOEXEC` are independent. Snapshot, retain, complete-batch send, and receive installation each reject non-owning or non-reconstructible metadata; any socket in the batch returns `EOPNOTSUPP` before carrier publication | Pipe/datagram queues retain supported ownership until one consuming receive, ordinary carrier-byte discard, or close. Forced process removal, AF_UNIX datagram reconnect, and `SHUT_RD`/`SHUT_RDWR` first make every discarded queue entry visible to the one deferred-release drain; `SHUT_WR` preserves the readable queue. Accept failure and plain transfer syscalls finish any ownership they discard. Every channel dispatch clears its temporary task identity, then conditionally drains deferred ownership after all resource-table borrows end and before publishing the result. Direct host-pipe exports use the same one-check boundary, so a future ancillary-capable input cannot strand ownership. PEEK owns temporary fallible clones only. Data and ownership become visible atomically before readiness wakeup; rejected batches publish neither | Shared Rust kernel on Node/browser; real guest wasm32/64; AF_UNIX datagram routing remains same-process; socket-descriptor transfer is an explicit unsupported boundary | **Confirmed live semantic and cleanup-boundary defects.** In addition to the seven transport defects, forced removal and reconnect could discard queued datagram rights after the sole drain, read shutdown made queued rights unreachable, failed accept discarded a preaccepted stream carrying rights, and `sendfile`/`copy_file_range`/`splice` consumed plain bytes while silently discarding ancillary ownership. Direct host-pipe exports were a latent future boundary rather than an existing public ancillary input | **Safe in current source.** Historical pre-retarget evidence includes native kernel and 18/18 real-musl Node cases across wasm32/wasm64. Current dirty-tree real-Chromium evidence passes the same 16 semantics cases plus two pipe-lifetime cases; the exact-final-head browser rerun remains pending |
| `host/src/kernel-worker.ts::{handleSpawn,decodeSpawnBlobStrings,handleSpawnAfterResolve,beginLargeSpawnScratch,cancelLargeSpawnScratch}`; `crates/kernel/src/spawn.rs::{SpawnScratchBuffer,measure_strings_by_offset,decode_measured_strings}`; `crates/kernel/src/wasm_api.rs::kernel_spawn_reserved_process` | Ordinary blob uses main allocation; large blob uses token-bound Rust `Vec<u8>` whose pointer and actual capacity are returned only while reserved | Complete blob at most generated 8,417,320; argv/environment representation at most 4 MiB; path/action/count caps from generated contracts | Caller ranges, parsed counts, paths, complete blob length, allocation capacity, current memory, pointer width, token, and reservation state are independent checks. Host and Rust first measure every referenced string against one aggregate budget, then allocate/decode | Async lookup owns a JS copy; begin/copy/commit have no await. Begin and pointer/capacity queries fail without waiting on contention. After every successful begin, cancellation runs in `finally`, including setup/copy failure. Commit and cancellation wait on the same no-host-import mutex and return only after the token is consumed, released, or shown stale; host/Rust guards reject overlap. Duplicate maximum-count offsets cannot amplify allocations before rejection | Node/browser; guest/kernel wasm32/64 | #1094 spawn fix was capacity-safe but retained a fixed 8,417,320-byte region after first large use; decoding still admitted allocation amplification from duplicate offsets | **Safe in current source.** Growable Rust-owned tokenized reservation, pre-allocation aggregate accounting, and exact-count/`ARG_MAX` boundaries are covered. The real Node/Chromium workload is historical pre-retarget evidence; the frozen final-head rerun remains pending |
| `host/src/kernel-worker.ts::{populateMmapFromFile,pwriteFromProcessMemory,readSysvShmRange,writeSysvShmRange}` | Main data allocation for transit, 65,536 bytes per chunk; mapped/shared bytes have separate owners | One `CH_DATA_SIZE` chunk; overall mapping/segment size comes from checked mapping/kernel state | Complete process/mapping range and each Rust producer/consumer count; transit lease separately proves scratch capacity/current memory | One synchronous lease per chunk; authoritative shared bytes/snapshots live outside scratch | Node/browser; guest/kernel wasm32/64 | Capacity fit, bare pointer contract | **Implemented; validation pending** |
| `host/src/kernel-worker.ts::{handleIpcShmat,handleIpcShmdt}` | Process `Memory` mapping and host `SysvShmMapping.snapshot`, not kernel scratch; address key is the checked native guest pointer | Segment size returned by the kernel attachment operation; full mapped range must fit process memory | Raw bigint address is checked losslessly for guest width before attachment/map lookup; mmap result and full mapped range are checked; failure rolls back attachment; shmdt uses the exact checked key | Coherence/attach/detach steps are synchronous; snapshot owns bytes between boundaries; no kernel scratch view is retained | Node/browser; guest wasm32/64 | **Confirmed high-address alias defect.** `>>> 0` narrowed wasm64 hints/detach keys so an address above 4 GiB could alias a low mapping | **Implemented; validation pending.** High hint, unsafe integer, and non-aliasing detach regressions |
| `host/src/kernel-worker.ts::handleSysvMessage`; `crates/kernel/src/ipc_wire.rs` System V message header conversion | Main data allocation; fixed kernel wire header plus payload; caller message begins with native `long` (4 wasm32, 8 wasm64) | Payload is syscall `msgsz`; header plus payload must fit 65,536 for one operation | Exact native mtype field and payload range; checked addition; width passed explicitly; Rust sees fixed wire format only | One synchronous lease; blocking retry retains owned parameters, not a scratch view | Node/browser; guest wasm32/64 | **Unsafe mixed-width/native-long and aggregate-capacity contract** | **Implemented; validation pending.** Exact capacity/capacity+1 and wasm32/64 mtype coverage |
| `host/src/kernel-worker.ts::handleIpcControl`; `crates/kernel/src/wasm_api.rs::{kernel_msqid_ds_bytes,kernel_shmid_ds_bytes}`; `crates/kernel/src/ipc_wire.rs::{read_*,write_*}` | Main data allocation; `msqid_ds` 96/120 and `shmid_ds` 88/112 for wasm32/64 | Exact layout size returned by required Rust query for `IPC_SET`/`IPC_STAT`; pointerless commands stage zero bytes | Width query, command direction, full caller range, allocation capacity, exact Rust slice, and narrowing checks; no fixed fallback | One synchronous lease; outputs serialize completely before copy-back | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe mixed-width contract.** Fixed wasm32 descriptors proved/staged the wrong LP64 ranges | **Implemented; validation pending.** Exact/short/null/unsupported-width tests |
| `host/src/kernel-worker.ts::handleSemctl`; `crates/kernel/src/wasm_api.rs::{kernel_semid_ds_bytes,kernel_semctl_array_bytes}`; `crates/kernel/src/ipc_wire.rs::write_semid_ds` | Main data allocation; `semid_ds` 72/88 or exact `2 * sem_nsems` array bytes | Rust permission-aware query is authoritative for GETALL/SETALL; structure query is authoritative for IPC commands | PID/TID, command kind, guest width, exact length, caller range, allocation capacity, and Rust slice bounds; missing/invalid required query fails closed | One synchronous lease; no `IPC_STAT` compatibility call is used to infer writable array capacity | Node/browser; guest wasm32/64 | **Confirmed unsafe.** Host assumed 1,024 array bytes and wasm32-only 72-byte structure | **Implemented; validation pending.** Exact/capacity+1, permissions, and missing-export regressions |
| `host/src/kernel-worker.ts::requireTcpScratchRegion` users: TCP, virtual network, UDP, browser-pipe bridges | Separate Rust allocation; private `tcpScratchRegion`, 65,536 bytes | One chunk at most 65,536; oversized UDP datagrams are rejected | Source/backend length, region capacity/current memory, and Rust producer count | Each callback/worker message enters one synchronous lease and detaches output before returning | Node/browser; kernel wasm32/64 | Sizes fit, but pointer escaped ownership value | **Implemented; validation pending.** Private capacity-bearing region |
| `host/src/kernel.ts` public socket/poll/terminal/ioctl/uname/pipe/rusage/select methods | Separate Rust allocation; private `apiScratchRegion`, 65,536 bytes | Call-specific exact fixed record or bounded payload; public poll accepts exactly `capacity / generated sizeof(pollfd)` = 8,192 entries and select uses generated 1,024-bit sets | Lease proves allocation and current memory; call validates the complete caller/result length and derives aggregate limits from the actual owned capacity rather than an unrelated protocol count | One synchronous public call; nested use fails | Node/browser; kernel wasm32/64 | **Confirmed unsafe ownership and artificial poll cap.** Temporary addresses 4 and 16 named no Rust allocation, while public poll reused `IOV_MAX` instead of its allocation capacity | **Implemented; focused Node validation passed.** Allocator-owned public scratch, poll exact-capacity/capacity+1, and generated select layout |
| `host/src/kernel.ts::{hostRead,readKernelBytes,writeKernelBytes}` and VFS (`stat`, `statfs`, `pathconf`, `readlink`, `readdir`), clock, random, waitpid, network/getaddrinfo, GL, proc, and KMS import callers | Rust-owned slice/local/struct lent as pointer plus explicit capacity for one import; `host_kms_mode_info` instead derives its exact 68-byte capacity from generated `WpkDrmModeModeinfo`; producer backends receive host-owned staging buffers rather than a live kernel view | Genuine intrinsic backend span no larger than the Rust-supplied or generated capacity; fixed formats use their exact generated/Rust size | Raw signed wasm32 or bigint wasm64 import pointer is normalized losslessly; nonnegative safe length, complete current-memory range, detached/staged producer data, and producer count precede one `writeKernelBytes` publish; no typed-array clamping or subclass getter counts as validation | Synchronous import only; neither backend nor callback receives a kernel-memory view | Node/browser; kernel wasm32/64 | Correct owner but incomplete conversions/result checks and live-view lending | **Implemented; validation pending.** Checked Rust-lent range plus host staging; high-bit wasm32 KMS and hostile-producer regressions; raw sink is explicitly allowlisted below |
| `apps/browser-demos/test/fixtures/opfs-advisory-lock-client-worker.ts::issue`; `apps/browser-demos/test/epoll-repro.ts::main` | Test kernel allocations represented as `KernelScratchRegion`; one complete channel | Fixed diagnostic channel and event records | Same lease capacity/current-memory rules as production | One lease covers stage/dispatch/snapshot | OPFS: real Chromium wasm32; epoll diagnostic: Node wasm32 | Sizes fit, bare diagnostic pointers/views | **Implemented; the historical authored-application Chromium run was blocked.** An earlier pre-final OPFS run passed, and the static contract includes both selected diagnostic sources. That broader historical run stopped before assertions because its program graph rejected an ABI-42 `bzip2.wasm`; it does not conflict with or count toward the later 28 focused minimal-runner Chromium passes |
| `host/src/{node,browser}-kernel-worker-entry.ts` clone/transport; process-worker argv/environment | Process `Memory`, `ArrayBuffer`, or `SharedArrayBuffer`, not kernel scratch | Process layout/worker-protocol limits | Process-owner and transport-specific validation | Worker/process lifetime, not a scratch lease | Node/browser; guest wasm32/64 | Outside allocator model | **Reviewed exclusion; final transport tests pending** |
| `host/src/framebuffer/**`; `host/src/dri/**`; GL command buffers; mmap/SysV backing views | Framebuffer/process memory or explicit host shared backing, never a pointer returned by `kernel_alloc_scratch` | Mapping/device-specific dimensions and buffer sizes | Subsystem owner/range contracts; static ownership seeds prevent reclassification as kernel scratch | Device/mapping lifetime; may be asynchronous by design, so no allocator-scratch view may enter these objects | Node/browser; guest wasm32/64 | Outside allocator model | **Reviewed exclusion, not declared globally safe.** Static contract covers ownership boundaries; subsystem-specific runtime validation remains required |

## Explicit write sinks and raw-write allowlist

All allocator-owned bulk transfers and scalar channel writes converge on the
following sinks. `KernelScratchDataView` is a guarded part of the abstraction,
not an allowance for a caller-created native `DataView`.
`KernelScratchLease.copyFrom` and `fill` are likewise abstraction-internal
guarded sinks. The only raw variable-size kernel-memory write outside that
abstraction is `WasmPosixKernel.writeKernelBytes`, whose pointer and capacity
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
| `host/src/kernel.ts::WasmPosixKernel.writeKernelBytes` — `getMemoryBuffer().set(...)` | `checkedWasmImportMemoryRange` normalizes the raw import pointer and proves the Rust-lent pointer, explicit/generated capacity, width, and current memory | The producer's intrinsic byte span must not exceed the supplied capacity; a typed-array subclass cannot under-report its real span | Complete synchronous import; **Rust-lent allowance** |

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
| `WasmPosixKernel` cached public/audio scratch across `init`/`initWithMemory` replacement | The wrapper cached allocator-owned regions containing the first generation's instance, memory, pointer, and capacity, but a later initializer replaced only the wrapper's current instance/memory. Subsequent public/audio calls could select the old region and old snapshotted export while other wrapper state named the replacement generation; a failed second instantiate could also leave new memory paired with the old instance | `kernel-initialization-lifetime.test.ts` allocates and uses both cached regions on wasm32 and wasm64, rejects cross-entry-point reinitialization before compile/instantiate or state mutation, proves the original generation still works, rejects a concurrent initializer, and proves a failed first attempt clears partial state before one clean retry |
| `ptyMasterWrite` — “chunks PTY input at the exact scratch capacity and capacity + 1” | The old single `.set(data, scratchOffset)` accepts more than the 65,608-byte allocation because only total linear memory constrains the typed-array write | 65,608 is one call; 65,609 becomes calls of 65,608 and 1; 16 KiB sentinel after the allocation is unchanged |
| `setCwd` — “rejects an oversized initial cwd before copying it” | `CH_TOTAL_SIZE + 1` encoded bytes are copied first; only the later Rust call applies `PATH_MAX` | Host rejects before `kernel_set_cwd` and before scratch mutation |
| `handleWritev` — “accounts for every writev table and alignment byte” | 1,024 iovecs contain 57,344 payload bytes, so the old `57,344 + 8,192 == 65,536` admission passes. Per-entry four-byte alignment makes the real footprint 68,608, writing 3,072 bytes beyond the data allocation | Complete `8 * count + Σ align4(len)` footprint is rejected or chunked; tail sentinel stays intact |
| `handleReadv` — “subtracts the complete readv iovec table from data capacity” | 1,024 entries request 65,528 data bytes. The old fast limit subtracts only one eight-byte entry, while the actual table is 8,192 bytes; the footprint is 73,720, or 8,184 bytes beyond the 65,536-byte data allocation | Complete table is included, `IOV_MAX` is enforced, returned bytes are bounded, sentinel is unchanged |
| `handleSendmsg` / `handleRecvmsg` — `IOV_MAX + 1` cases | The old path calls Rust instead of rejecting count 1,025 with `EINVAL` | Count 1,025 is rejected before scratch mutation or Rust dispatch |
| `handleSendmsg` / `handleRecvmsg` — complete-layout boundary and historical allocation-sized table cases | Count 8,192 alone consumes 65,536 kernel-table bytes, but the old path also writes the 28-byte kernel message header and aligned optional/data sections. That historical count is above `IOV_MAX`, so current code rejects it at the count check rather than exercising the capacity boundary | One 65,500-byte iovec makes the complete header/table/data layout exactly 65,536 bytes and is accepted; 65,501 is rejected before dispatch. Exactly 1,024 zero-length entries are accepted, while the historical 8,192-entry case is rejected by `IOV_MAX`; the sentinel stays unchanged |
| `handleSendmsg` / `handleRecvmsg` multi-iovec behavior | The old kernel-facing path serialized the caller's full count but Rust read only the first table entry, so later payload sources/destinations were silently ignored even when all ranges fit | wasm32 and wasm64 send flatten every entry in order; receive scatters the detached result across every entry, including correctly skipping a zero-length middle entry |
| wasm64 ancillary translation and capacity | The old path copied a native 16-byte-aligned wasm64 `cmsghdr` into a kernel parser expecting the 12-byte wasm32 shape. On receive, `CMSG_SPACE(sizeof(int)) == 24` could be misread as canonical room for two FDs even though one native record has only one logical FD of data | Generated native layouts translate to/from the fixed 12-byte canonical wire. A native `CMSG_LEN(sizeof(int)) == 20` maps to exactly one canonical FD; exact native capacity matrices, poisoned padding, `MSG_CTRUNC`, and sequential shorter reuse preserve caller canaries |
| Malformed ancillary length and canonical output | A wrapped/overlong length could reach unchecked pointer arithmetic or allow a returned record to publish partial guest output | Wrapped native input fails before scratch mutation. Partial, overlong, misaligned, or capacity-plus-one canonical output becomes `EIO` before any payload/name/control/header publication |
| Kernel channel C-string allocation boundary | The old Rust scanner accepted a bare kernel pointer, stopped at a duplicated 4,096-byte constant, and did not carry the channel allocation capacity that authorized each dereference | Pointer zero, before-start, exact-end, overflow, and a missing NUL before the allocation end return `EFAULT`; a NUL in the last owned byte succeeds, and a generic non-path string larger than `PATH_MAX` remains valid |
| Positive-count null dynamic buffers and zero-count null buffers | The old generic host path did not make a positive `Arg` extent independently imply a non-null source/destination, while a raw zero-count process pointer could cross address spaces even though no caller bytes were borrowed | wasm32 and wasm64 `read`/`write` with count 1 and pointer 0 fail with `EFAULT` before dispatch. Count 0 with pointer 0 reaches Rust only as the allocation start with zero extent, never as the caller address |
| Positive-size fixed output nullability (`pipe(NULL)` and `uname(NULL)`) | Absence of `required` metadata was interpreted as permission for null, so fixed outputs could reach Rust without an owned destination and write through kernel address zero | Every generated pointer descriptor is exactly one of required or nullable; the reviewed nullable set is asserted exactly. wasm32 and wasm64 `pipe`/`uname` null outputs fail before kernel dispatch |
| Non-null `Deref` outer buffer with a null length pointer | `accept`, `accept4`, `recvfrom`, `getsockname`, and `getpeername` derive output capacity from a separate `socklen_t *`. The old host could leave the non-null caller outer pointer in adjusted kernel args when that capacity pointer was null, crossing address spaces before later rejection | wasm32 and wasm64 `recvfrom` reject the malformed pair before scratch mutation or dispatch; the same shared planner covers every `Deref` descriptor |
| One-snapshot, order-independent `Deref` planning | The old planner could size a destination from one `socklen_t` read and stage a later, mutated value; it also depended on the generated dynamic descriptor preceding the fixed length descriptor. A larger staged value could authorize Rust to use bytes the host had not reserved | The regressions mutate 4 to 28 between hypothetical reads and reverse the generated `recvfrom` descriptor order. The host performs one caller-memory read, stages that same value, and leaves the adjacent canary unchanged. Rust validates allocation order/range, with the documented alignment-bucket limitation because no separate unpadded capacity is encoded |
| Option-sensitive `prctl` argument 1 | The generic descriptor treated argument 1 as a fixed 16-byte pointer for every option, so scalar operations such as `PR_SET_NO_NEW_PRIVS` had their value replaced by a scratch address | wasm32/wasm64 scalar options preserve the canonical low-32-bit value and stage no buffer; `PR_SET_NAME`/`PR_GET_NAME` stage exactly 16 bytes in the correct direction and reject null before dispatch |
| `SCM_RIGHTS` stream carrier position and `MSG_WAITALL` | The old side queue could return a descriptor before the byte with which it was sent, and a wait-all read could cross more than one rights boundary | The real-musl fixture queues `A`, rights with `B`, then `C`; a nonblocking wait-all receive returns exactly `AB` with the descriptor, and the next receive returns `C` |
| `SCM_RIGHTS` stream `MSG_PEEK` with short control | The old PEEK path removed the sole retained descriptor ownership even though it left stream bytes queued | A no-control peek and a `CMSG_LEN(0)` peek report no installed fd/`MSG_CTRUNC` as appropriate; two full peeks and the final consume all see a valid descriptor without sender ownership |
| Addressed and connected AF_UNIX datagram rights | Datagram queue entries previously dropped control ownership, and non-Unix destinations could reach partial data publication | Abstract-address `sendmsg.msg_name` and connected sends deliver payload and rights atomically; the sender alias may close before receipt. Non-AF_UNIX ancillary use returns `EINVAL` before data becomes visible |
| Zero-byte and zero-iovec rights | Fast exits bypassed the message ownership path, so zero-byte datagrams could lose rights or be consumed by an ordinary zero-length read | A datagram `sendmsg`/`recvmsg` with `msg_iov == NULL` and `msg_iovlen == 0` transports rights. `read(fd, ..., 0)` leaves that message queued for the later receive; a zero-byte stream send queues nothing and releases its temporary retain |
| Datagram input/output `MSG_TRUNC` separation | The old receive path used the input flag only and did not report output truncation in `msg_flags` | A short receive always reports output `MSG_TRUNC`; without input `MSG_TRUNC` it returns the copied prefix, and with the input flag it returns the full datagram length |
| `MSG_CMSG_CLOEXEC` | The old receive path installed transferred descriptors without applying the requested close-on-exec flag | The received descriptor has `FD_CLOEXEC`, is reflected in output flags, and is absent after the fixture execs itself; installation failure publishes no partial control result |
| `SCM_RIGHTS` descriptor transferability | A process-local socket snapshot preserved scalar metadata but not the authoritative endpoint or queue backing, so reporting successful socket transfer created a descriptor that could not preserve the source object | The real-musl wasm32/wasm64 fixture first proves pipe transfer still succeeds, then attempts AF_UNIX stream/datagram and AF_INET/AF_INET6 socket descriptors. Every socket batch returns `EOPNOTSUPP`, publishes no carrier byte, and retains no hidden reference. Native tests also reject stale, structurally incomplete, and non-owning in-flight records before installation |
| Forced process removal with queued datagram rights | `remove_process_inner` performed its sole deferred-release drain before dropping each socket's datagram queue, so the queue could enqueue backing work after the last cleanup boundary | `forced_removal_drains_scm_rights_queued_in_unix_datagrams` closes the sender alias, forces removal, and proves the in-flight OFD, host handle, and advisory lock all reach their final state |
| AF_UNIX datagram reconnect with queued rights | Replacing the datagram peer cleared the old queue only after the enclosing operation's cleanup opportunity, leaving its retained descriptors stranded | `unix_datagram_reconnect_drops_and_drains_scm_rights_ownership` proves reconnect discards and finishes the old queue before publishing success |
| Datagram shutdown modes with queued rights | `SHUT_RD` and `SHUT_RDWR` made queued messages permanently unreadable without releasing their `SCM_RIGHTS`; `SHUT_WR` must not destroy still-readable data | `unix_datagram_shutdown_modes_preserve_or_discard_scm_rights_correctly` covers both discarding modes plus `SHUT_WR` preservation and later receipt |
| Failed accept of a preaccepted stream carrying rights | An error after selecting a preaccepted AF_UNIX stream dropped its pending ancillary state without finishing the retained backing | `failed_accept_discards_and_drains_preaccepted_stream_scm_rights` injects the failure and proves no OFD, host handle, or lock ownership remains hidden |
| `sendfile` / `copy_file_range` / `splice` crossing a stream rights boundary | These plain-data transfers call the ordinary read path. It correctly refuses to return ancillary ownership, but the wrappers did not finish the ownership discarded at that boundary | `plain_transfer_syscalls_discard_and_drain_crossed_stream_scm_rights` executes all three operations and verifies both the copied byte and final retained-resource state |
| Direct host pipe read/close boundaries | Today these exports normally address host-injected TCP pipes, but message-aware read and unreachable-cycle collection can enqueue deferred ownership if that trusted input boundary broadens | `direct_host_pipe_read_and_close_read_detect_deferred_scm_cleanup` and `direct_host_pipe_close_write_detects_recursive_ancillary_collection` exercise the exact pending predicate and cleanup helper used after the pipe-table borrow ends |
| Systematic channel-dispatch cleanup order | A per-syscall list can miss a new transitive `Drop`, early return, or replacement that queues ancillary cleanup; cleanup while a task identity or resource-table borrow remains live can also re-enter with stale authority | Every channel result crosses one conditional machine-owned cleanup boundary after dispatch clears the current-TID binding and before result publication. The empty path performs one O(1) pending check; the pending path drains only after resource borrows have ended |
| Vector/message wasm64 nested pointers | `Number(bigint)` loses an unrepresentable iovec/base/header pointer and permits an aliased range to reach Rust | Raw bigint remains intact through guest-width and safe-integer checks; failure precedes mutation |
| Public poll exact allocation boundary | The public wrapper used the unrelated `IOV_MAX` value 1,024 even though its owned 65,536-byte region can hold 8,192 generated eight-byte `pollfd` records | Exactly 8,192 records are admitted and 8,193 is rejected before mutation; readiness parsing uses generated offsets |
| Slow `preadv` / `pwritev` positioned offset | Reassembling the signed high and unsigned low words as a JavaScript `Number` rounds `2^53 + 1` down to `2^53`, so the chunked path re-emits the wrong low word | Offset assembly, per-chunk addition, write-budget preflight, and low/high re-emission remain `bigint`; wasm64 ingress normalizes the complete low slot before any Number conversion |
| Ordinary and large `pread` / `pwrite` positioned offset | The generic ordinary path converted the signed i64 channel slot to `Number`, and the large path reused that rounded value across preflight and chunks. Shared-mapping follow-up could then index the rounded page | Both caller widths preserve `2^53+1` on the ordinary path and increment it exactly across a 65,536-byte chunk; an offset that cannot be indexed losslessly triggers authoritative mapping refresh instead of an aliased update |
| `Getaddrinfo` generic descriptor — “copies only getaddrinfo's four-byte result before the caller canary” | The old fixed 256-byte output descriptor copies 252 bytes beyond musl's four-byte result object | Detached copy-back is exactly four bytes and preserves a 252-byte canary |
| `handleGetgroups` and `kernel_getgroups` | The old generic call passes the caller's process pointer as if it were a kernel pointer; Rust writes one `u32` without receiving the owned destination capacity | Size zero lends pointer/capacity zero; positive size lends exactly four bytes; Rust rejects capacity 0/3 and accepts 4/5; detached gid copy precedes reuse |
| `Setgroups` generated descriptor | The old raw pointer crosses address spaces. The current Rust implementation does not dereference it, so this is an unsafe contract rather than a claimed observed overwrite | Exactly 16,384 gids fit; 16,385 is rejected; count zero ignores even an unrepresentable pointer; positive null returns `EFAULT` |
| Request-aware `ioctl` — FIONREAD canary and exact capacities | The old generic 256-byte argument copies back 252 bytes beyond a four-byte FIONREAD object; it also cannot distinguish scalar/no-argument requests from pointer requests | FIONREAD copies exactly 4; wasm32 TIOCGPTN is 4, wasm32 DRM VERSION is 36, wasm64 DRM VERSION is 64; one-byte-short/null fail before mutation; scalar/no-arg/unknown stage no pointer |
| Width-incompatible `ioctl` requests | The old contract has no lossless distinction for pointer-bearing wasm32-only layouts such as `GLIO_QUERY` and wasm32 DRM VERSION | wasm64 rejects those known requests with `EOVERFLOW` before conversion or copy |
| Caller-native process records | Fixed wasm32/partial descriptors under-copy or copy back the wrong layout for wasm64; `sigevent` was treated as 16 rather than 64 bytes; `sysinfo` used stale syscall 208 instead of musl 269 | `tests/abi/{process-native-layouts,fixed-process-layouts}.c`, Rust exact/short tests, and host `sysinfo` exact-end/one-byte-short tests cover the enumerated 12/24, 16/32, 32/64, 64, 88/120, 312/368, 128, 112, and 48-byte records |
| Signal dequeue output capacity and complete `SA_SIGINFO` record | The old `kernel_dequeue_signal(pid, tid, out_ptr)` accepted a bare kernel pointer, while its 44-byte payload inside a 48-byte reserved channel area omitted a complete raw `si_value` plus sender/timer metadata | `signal_delivery_output_requires_nonnull_exact_capacity` rejects null, 55, and 57 while accepting exactly 56; `signal_delivery_record_serializes_every_field_at_the_shared_offsets` covers the full generated record. The rebuilt real-musl `process-native-layout` Node cases pass on wasm32 and wasm64 and exercise handler-side C reconstruction, raw value width, `si_code`, PID, and UID |
| Mqueue notification drain and registration validation | The old one-argument drain export had no allocation-capacity proof. A negative Rust errno is truthy in JavaScript, so the old host could parse unchanged reusable bytes as a pending `{pid, signo}` notification. `mq_notify` also admitted invalid signal numbers into the one-shot registration slot | Source requires an exact eight-byte destination and queues the full raw value with `SI_MESGQ` and sender metadata independently of the wake record. The host regression accepts only integer results 0/1 and fails closed on `-EINVAL` without waking or signaling. Native coverage rejects 0, `NSIG`, and `u32::MAX` without occupying the slot, then proves a valid registration succeeds. The real-Wasm export regression rejects pointer zero and capacities 7/9 without consuming or mutating the pending record, then accepts capacity 8 and preserves both destination canaries |
| POSIX timer `sigevent` pointer width and full `sigval` | The old three-argument `kernel_timer_create` could not distinguish a wasm32 from wasm64 caller and parsed only a partial event, narrowing a wasm64 pointer value | `mq_attr_and_sigevent_follow_process_long_width` covers exact 64-byte wasm32/wasm64 layouts, short/long rejection, and raw four/eight-byte values. The rebuilt real-musl `process-native-layout` Node cases verify the low 32 bits for wasm32 and all 64 bits for wasm64 through `timer_create`, expiration, and `sigtimedwait` |
| Signal sender metadata for plain raise/kill versus queued sources | Plain self-raise previously reached the metadata-bearing queue with PID/UID zero, making handler `siginfo_t` inconsistent with the authoritative process identity | `test_raise_preserves_self_sender_metadata` and `process_signal_metadata_distinguishes_kill_from_sigqueue` distinguish SI_USER/SI_QUEUE while preserving sender PID/UID and raw queued value. The same rebuilt real-musl Node fixture checks the handler-visible fields |
| `handleEpollCtl` / `handleEpollPwait` native event layout | A stale 12-byte assumption cannot represent musl's required padding before 64-bit `data` and proves the wrong output range | Exact record is 16 bytes: events offset 0, padding 4–7, data offset 8; exact-end and one-byte-short input/output tests verify padding and data |
| wasm64 `handleIpcShmat` | `shmaddr >>> 0` aliases a hint above 4 GiB to its low 32 bits before mmap/attachment logic | `0x1_0000_0000n` reaches mmap unchanged; values above `Number.MAX_SAFE_INTEGER` fail before attachment |
| wasm64 `handleIpcShmdt` | `args[0] >>> 0` can select and detach an unrelated low mapping for a high native pointer | A high address equal to an existing low key plus 4 GiB neither aliases nor detaches the low mapping |
| wasm64 `msgctl` `IPC_STAT`/`IPC_SET` | Fixed 96-byte wasm32 descriptor validates/stages the wrong range instead of the 120-byte LP64 structure | Required size query selects 96/120 and exact/short ranges |
| wasm64 `semctl` `IPC_STAT` | Fixed 72-byte wasm32 layout is selected instead of the 88-byte LP64 structure | Required size query selects 72/88; array size comes from permission-aware Rust preflight |
| wasm64 `shmctl` `IPC_STAT`/`IPC_SET` | Fixed 88-byte wasm32 descriptor validates/stages the wrong range instead of the 112-byte LP64 structure | Required size query selects 88/112 and exact/short ranges |

The expanded parameterized coverage includes those failures plus caller
address zero, adjacent vector slow paths, large read/write, select/pselect,
`ppoll` special-pointer conversion, epoll, wasm32/wasm64 System V IPC control
layouts, generic descriptor invalid lengths, lease-time staging, and
Linux-compatible `MSG_TRUNC`. Final case counts belong in the post-retarget
validation report, not this in-progress rehearsal record.

Additional focused files cover the complete abstraction:

- `host/test/kernel-scratch-region.test.ts`: exact capacity/capacity+1,
  negative/fractional/unsafe integer inputs, pointer arithmetic, null,
  end-of-memory, allocation failure, invalid allocator range, wasm32/64,
  signed-high allocator/reservation results, sequential/nested/async use,
  single-use revocation, hostile `then`/typed-array methods, escaped views, and
  `memory.grow()`.
- `host/test/kernel-public-scratch.test.ts`: removal of low-address scratch,
  public capacity, audio counts, signed-high raw import pointers, hostile
  producer views, exact KMS mode-info size, and Rust-lent network output
  bounds.
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
  signal-event, interval-timer, message-queue, filesystem-statistics, and
  system-information records, including the native `union sigval` width.
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
  record reconstructs native `si_value`, `si_code`, PID, and UID; its timer
  and mqueue cases preserve four-byte wasm32 and eight-byte wasm64 values and
  reject invalid `mq_notify` signums. Focused host boundary tests separately
  prove `sysinfo` exact-end admission, one-byte-short rejection, and that a
  negative mqueue drain result cannot decode stale scratch. The two runtime
  cases are self-contained and set `useDefaultRootfs: false`; both passed on
  Node against the rebuilt ABI-43 kernel and host artifacts. Chromium
  execution of this latest fixture remains pending.
- `crates/kernel/src/mqueue.rs`, `crates/kernel/src/signal.rs`,
  `crates/kernel/src/syscalls.rs`, and
  `host/test/kernel-scratch-transfer-boundaries.test.ts`: invalid mqueue
  signums leave the registration slot free, `SI_MESGQ` and sender metadata
  remain in the Rust-owned signal queue, plain self-raise reports the real
  sender, and the host publishes no notification after a negative drain
  result.
- `host/test/sysv-ipc.test.ts`: end-to-end wasm32/wasm64 message-queue,
  semaphore, and shared-memory control operations, including `IPC_SET`. Its
  two self-contained runtime cases also set `useDefaultRootfs: false` and
  both passed against the rebuilt ABI-43 kernel and host artifacts.
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
  mutable mailbox before worker construction fails.
- `host/test/timerfd-signalfd-scratch.test.ts`: guarded caller objects for the
  exact wasm32/wasm64 timer and signal-mask records. Both focused cases passed
  after the current ABI-43 kernel and host artifacts were rebuilt. Like the
  other self-contained native-layout fixtures, it sets
  `useDefaultRootfs: false`.
- `host/test/kernel-scratch-contract.test.ts` and
  `host/test/wasm-memory-write-audit.test.ts`: compiler-backed repository drift
  guard plus focused ownership-propagation, write-kind, escape, exact-allowlist,
  direct/aliased/destructured/computed pointer-export invocation, wrapped
  callable escape, `call`/`apply`/`bind`, and reflective invocation fixtures.
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
- `programs/scm-rights-pipe-lifetime.c`,
  `host/test/scm-rights-pipe-lifetime.test.ts`, and
  `apps/browser-demos/test/fifo-lifecycle.spec.ts`: the same real musl
  `sendmsg`/`recvmsg` and `SCM_RIGHTS` workload is built for both wasm32 and
  wasm64. Its one-FD receive uses the exact native `CMSG_LEN` capacity, making
  wasm64's 20-byte logical record distinct from its 24-byte aligned storage.
  Node and Chromium results are recorded only after those commands run.
- `programs/scm-rights-semantics.c`,
  `host/test/scm-rights-semantics.test.ts`, and
  `apps/browser-demos/test/scm-rights-semantics.spec.ts`: eight independent
  real-musl cases cover stream carrier barriers/`MSG_WAITALL`, non-consuming
  short/full stream `MSG_PEEK`, addressed/connected and zero-iovec AF_UNIX
  datagrams versus ordinary `read(...,0)`, independent input/output
  `MSG_TRUNC`, non-Unix rejection, an unrepresentable descriptor batch,
  zero-iovec stream behavior, and `MSG_CMSG_CLOEXEC` across exec. The
  post-retarget Node matrix passed all 16 wasm32/wasm64 semantic cases; the two
  existing pipe-lifetime cases also passed, for 18 total Node cases. The
  focused real-Chromium runs passed the same 16 semantic cases and both
  pipe-lifetime cases. These are dirty-worktree results and still require the
  frozen-head rerun described below.

## Evidence boundaries and external gaps

These validation gaps prevent a “ready” disposition. They do not erase a
source-safety proof, and a source-safety proof does not substitute for these
missing runs. Any row still marked **Uncertain** separately remains without a
safe source disposition.

1. Retargeting to merged PR #1097 is complete. Exact-head readiness is a
   per-PR gate: the draft PR ledger must name the current head and the complete
   rerun performed on it. Test presence, an earlier source fingerprint, or a
   pre-retarget run is never substituted for that evidence.
2. Framebuffer, Direct Rendering Manager (DRM), OpenGL, shared-mapping, and
   process-worker transfers are deliberately excluded from allocator scratch.
   The static ownership audit can prove that no kernel scratch view escapes
   into those objects; it cannot by itself prove every subsystem's mapping
   dimensions, callback lifetime, or browser behavior.
3. Focused post-retarget Chromium execution now covers the scratch runtime,
   native wasm32/wasm64 process layouts, both child-wait widths, all 16
   wasm32/wasm64 `SCM_RIGHTS` semantic cases, both pipe-lifetime cases, and the
   adjacent path, file-limit, and terminal fixtures: 28 assertions passed in
   real Chromium. Those self-contained fixtures explicitly select the test
   runner's minimal dependency set; they do not bypass validation for any
   artifact they request. Vite's optional application dependency pre-scan
   still warns about unavailable ABI-43 tools, and the complete browser
   application suite remains blocked by those package artifacts. Focused
   browser evidence does not establish every device/shared-memory exclusion or
   the unexecuted application graph.
4. The normal conformance runners were reprobed after retargeting and all stop
   before the guest reaches the kernel because no one provenance tier contains
   the complete ABI-43 program closure. Open POSIX `sigqueue sigtimedwait`
   reported 0 pass, 17 fail, and 1 timeout. libc-test `functional spawn`
   reported 0 pass and 1 fail. Sortix `signal` reported 0 pass, 14 fail, and 18
   timeouts; a separately enumerated complete 24-test `basic/spawn/*` surface
   reported 0 pass and 24 fail. A direct launch shows the exact cause:
   `local-binaries` is not one direct immutable generation, `binaries` is not
   one canonical program-cache generation, and the installed package lacks
   `programs/wasm32/git/git.wasm` plus `git-remote-http.wasm`. No resolver
   bypass, mixed-provenance selection, or test-only exception was added.
5. Comparable post-retarget dirty-worktree measurements establish reported
   retained scratch capacity and post-run/peak kernel linear memory for the
   deterministic workload on Node and real Chromium. Exact-PR-head result
   files and fingerprints belong in the mutable PR ledger. Three-round timing
   samples and the baseline-harness provenance are insufficient for a speed or
   broad no-regression claim. The performance guide's complete application
   suites remain blocked by unavailable ABI-43 PHP, WordPress, and MariaDB
   artifacts.
6. The declared development shell does not provide its pinned
   `rustfmt`/`cargo-fmt`; the only discovered formatter is an undeclared
   Homebrew binary that produces unrelated repository-wide churn. Rust
   formatting validation is blocked until the declared toolchain supplies the
   formatter.
7. PR #1097 merged as
   `c7d039794a43788acfa0b0aea30a700c257f57cb`, and retargeting is complete.
   The draft must remain unapproved and unmerged whenever its validation ledger
   does not match its current exact head.

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

## Historical pre-retarget spawn buffer sizing evidence

All numeric results in this section are historical #1094-baseline or
pre-retarget dirty-worktree measurements. They are retained to explain the
buffer-design decision; they are not current final-head performance evidence.
Exact-PR-head retained-memory and timing results are recorded in the mutable
draft PR ledger under the recording contract at the end of this section.

Three designs were evaluated:

1. The #1094 fixed 8,417,320-byte kernel allocation is simple and safe, but
   first use just above channel size retains the complete worst case.
2. A Rust-owned reusable `Vec<u8>` can grow to the requested high-water mark.
   A fresh token must bind every operation even when the existing capacity is
   reused. `try_reserve_exact` reports allocation failure before publishing a
   reservation; begin is rejected while another reservation is active.
3. Repeated/geometric host calls to `kernel_alloc_scratch` have no free
   operation and would permanently leak every older region. That design was
   rejected. ABI 43 has no host-allocation or older-kernel fixed-buffer
   fallback.

The tokenized Rust-owned reusable region is the chosen current-source design
because Rust remains the sole allocation owner and no pointer
can be used without an active exclusive reservation. Begin and the
pointer/capacity queries are nonblocking; contention returns `EBUSY` or zero.
After every successful begin, host cancellation runs in a `finally` block,
including setup and copy failures. Commit and cancellation wait on the same
no-host-import critical section and return with a definitive token state.
Commit parses the selected prefix into owned vectors and drops the scratch
lock before process-table work or host imports, so the allocation lifetime and
reentrancy rules are mechanically enforced rather than inferred from
JavaScript event-loop behavior.

The workload performs one ordinary spawn with the fixed environment `LANG=C`,
`PATH=/bin`, one spawn whose complete wire blob is exactly 84,386 bytes, and
five more spawns at that size. It fails a sample unless every waited child
exits normally with status zero. Each round starts a fresh dedicated kernel
worker. The fixed-buffer baseline was built from an isolated archive of exact
#1094 head `6d923c6454dd7174082f25c3d3991d03f86f5ddb`; its temporary
host-only telemetry reported the existing fixed constant after program
completion and did not change kernel allocation or copy behavior. The
hardened measurements used the tokenized ABI-43 kernel and host artifacts at
the fingerprinted rehearsal state below. Subsequent descriptor and dispatcher
hardening means those fingerprints are not the current source head.

Earlier diagnostic samples used a workload whose ordinary environment was
host-derived and which did not reject a nonzero or abnormal child exit. They
are superseded and are not presented as evidence for the hardened workload
described above.

The comparable rehearsal measurements completed on July 25, 2026. Values are
medians of three fresh-worker rounds; times are milliseconds and memory is
bytes:

The measured toolchain was Node.js `v24.15.0`, Playwright `1.61.0`, and
Chromium `149.0.7827.55`.

| Host and design | Ordinary spawn | First 84,386-byte spawn | Five repeated 84,386-byte spawns, per spawn | Reported retained scratch capacity | Kernel linear-memory high-water mark |
|---|---:|---:|---:|---:|---:|
| Node, #1094 fixed buffer | 51.378 | 47.488 | 46.3876 | 8,417,320 | 26,017,792 (397 pages) |
| Node, tokenized growable buffer | 46.8 | 44.08 | 43.28 | 84,386 | 17,694,720 (270 pages) |
| Chromium, #1094 fixed buffer | 14 | 12 | 11 | 8,417,320 | 26,017,792 (397 pages) |
| Chromium, tokenized growable buffer | 14 | 11 | 10.2 | 84,386 | 17,694,720 (270 pages) |

The focused workload therefore measured 8,332,934 fewer bytes of reported
retained scratch capacity, a 98.997% reduction. Whole kernel linear memory was
8,323,072 bytes, or 127 64-KiB pages, smaller after the workload (31.990%).
Those are memory measurements, not an allocator-rounding claim. The three
timing samples are too small and noisy to support a speedup or no-regression
claim; no such claim is made.

For this design, post-run kernel memory equals peak kernel memory only because
WebAssembly memory grows monotonically and cannot shrink. Post-run Rust
`Vec<u8>` capacity is the retained scratch high-water mark only because the
kernel intentionally keeps that reusable allocation and does not shrink it
between spawns. These implementation properties make the final samples valid
for this workload; they are not a general substitute for peak-memory
instrumentation.

The prepared hardened workload source has SHA-256
`53556d1ad905c92b70b0f5cff29babcf5c0b3183185cdd6a86303eac18f14cc5`.
The exact-#1094 and measurement-time hardened workload Wasm files have SHA-256
values
`b207969191ac8132150d43a84f0f2857db4326e7108b93ff60be7159de835514`
and
`e0738d4e6f87e099aa843ae562b03f14b1e16dd30b92abed2302a429c8119cfc`.
The exact baseline kernel Git tree is
`6a8721697edbfa5f4fbd22cb21b41d8ccdcc4a2e` and its built kernel SHA-256 is
`e6979f1fa7fdec68959c7f735c3c16ea91060c61cd203e86fd02eaf9a00326bd`;
the measurement-time hardened built-kernel SHA-256 is
`db2835a4905023c81a3eecaa6861feb955ea0610eb34763a8de65983b8a96ddb`.
The measurement-time hardened Node worker bundle is
`f3e1ae982b9c85fffa8caf85907e9c73e52db1cd24e7a9a2da2a132af279dfdb`,
and the measurement-time `host/src` fingerprint is
`89c24dba492309f0196059184e9af0ffaca4e91f1faa139ed0caa0be6574ac21`.
The fixed-baseline Node and Chromium raw logs have SHA-256 values
`f4374b0df0a66bbbd56f19c5637542fa8f40bbfe5f552b23af055c43fcb18dcc`
and
`a0a4b52088ab19ad71bc88ee48c514e1bc5b0c5c58f33410c66a2bcf5d44e814`.
The measurement-time rehearsal result files are
`benchmark-node-1785010575047.json` with SHA-256
`78ccaac5f4b737b34b934f68ae808769512c3da824414452dd06d6a325b42fc8`
and `benchmark-browser-1785010588397.json` with SHA-256
`bbef0b4bb0f82edc3d7f4fcfbc07d8e4fcc88ded464f989a99d2888e96794ede`.
Those result files fingerprint the exact runtime inputs above, but their Git
metadata records older committed head
`08620d9233a2812eb1098fe6e7b53a7fba58afb4` while the measured implementation
was still uncommitted. Later scratch-contract changes also postdate those
fingerprints. The files are evidence for the stated rehearsal workload only,
not a substitute for exact committed-head and post-retarget reruns.

### Historical pre-retarget dirty-worktree evidence

The later pre-retarget same-worktree focused results were produced on July 26,
2026 with:

```bash
scripts/dev-shell.sh npx tsx benchmarks/run.ts --host=node \
  --suite=spawn-scratch --rounds=3
scripts/dev-shell.sh npx tsx benchmarks/run.ts --host=browser \
  --suite=spawn-scratch --rounds=3
```

Their digests were computed through the declared development shell with:

```bash
scripts/dev-shell.sh sha256sum \
  benchmarks/results/benchmark-node-1785057474317.json \
  benchmarks/results/benchmark-browser-1785057482750.json
```

The Node result is
`benchmarks/results/benchmark-node-1785057474317.json`, SHA-256
`dfea628c210f77430266d83ec8a48d92387a24870d8b427dd22021354591619d`.
It records timestamp `2026-07-26T09:17:54.316Z`, host `node`, Darwin arm64,
Node.js `v24.15.0`, three rounds, Git head
`b840bf2f145b264512a169dacdee21df1d4ea36b`, and Git ref
`remotes/origin/fix/kernel-scratch-capacity-j5u66-draft`.
The Chromium result is
`benchmarks/results/benchmark-browser-1785057482750.json`, SHA-256
`dfd44e7b810be14afd7af86e8625b7f860600bfdd855abc4052d91c566851f88`.
It records timestamp `2026-07-26T09:18:02.750Z`, host `browser`, the same
platform, architecture, Node.js harness version, round count, Git head, and
Git ref. The result format does not record the browser executable version. A
same-tree declared-shell inspection reported Playwright `1.61.0` and Google
Chrome for Testing `149.0.7827.55`; those versions are environment metadata,
not fields authenticated by the result-file digests.

Both files fingerprint the same measured inputs:

- `local-binaries/kernel.wasm`: 642,109 bytes, SHA-256
  `e2abb9bf9d1b88e47e46f7971036fc44a417b6f4a43819b3319a90b0880b4df8`;
- `host/src`: 111 files and 2,781,747 bytes, SHA-256
  `d5fbfab41983255f2cf0dc0141d2dd82295dd15782b4cbee276abed46004cb64`;
- `benchmarks/wasm/spawn-bench.wasm`: 38,317 bytes, SHA-256
  `e0738d4e6f87e099aa843ae562b03f14b1e16dd30b92abed2302a429c8119cfc`;
- `benchmarks/wasm/hello.wasm`: 7,158 bytes, SHA-256
  `4c059e672853793fe2b0177c205de28d88cd7e8e84dabb79f30353708dce2741`.

The Node file additionally fingerprints the selected
`host/dist/node-kernel-worker-entry.js`: 1,260,964 bytes, SHA-256
`80f648f79f4b1020bd8f08e6f0bc545696de66a093b65a2566821661996b3cea`.

| Host | Ordinary spawn | Wire bytes | First large spawn | Repeated large spawn | Retained scratch | Kernel memory |
|---|---:|---:|---:|---:|---:|---:|
| Node | 49.8 ms | 84,386 | 48.19 ms | 46.94 ms | 84,386 bytes | 17,694,720 bytes |
| Chromium | 20 ms | 84,386 | 17 ms | 15.4 ms | 84,386 bytes | 17,694,720 bytes |

These are historical pre-retarget dirty-worktree observations, not
committed-head evidence: the JSON Git metadata identifies the checked-out
commit, while the artifact hashes identify the uncommitted runtime inputs
actually measured. They preserve the historical fixed-buffer comparison above
rather than replacing it; no contemporaneous fixed-buffer rerun was made.
Three-round timings do not support a latency improvement or no-regression
claim, and none is made. Retargeting is complete, but the exact frozen final
head still requires its own Node and Chromium reruns.

The baseline archive was exact #1094 plus a host-only telemetry diff, with
SHA-256
`f78fbd452f1b758aa9494998e00816aae521d1fc4d66e5c2a0d7de8062ebe73e`;
that diff reported the already-retained fixed capacity and did not change the
kernel allocator or copy path. Its Node worker bundle was
`dd9e9e03c84d80df116448594727f2e12af2957bac3b1e55b3fa9c7b27df5e35`.
The older Chromium wrapper labels the combined run `process-lifecycle`, while
the hardened measurement wrapper labels the isolated component
`spawn-scratch`; both
created a fresh browser kernel for each round and ran the same hardened spawn
workload. This provenance limitation is why the focused results are evidence
for buffer sizing, not broad application performance.

The browser benchmark now loads optional application URL graphs only when an
application suite asks for them. The dedicated Node `spawn-scratch` suite uses
an empty filesystem because it supplies both executables; the established
`process-lifecycle` suite still requires its default rootfs. Those dependency
declarations let the focused scratch measurement run without weakening the
resolver or silently changing existing process metrics. Application suites
still resolve and enforce the same package policy. Broader Node/browser
application measurements remain blocked by unavailable ABI-43 package
artifacts. The focused workload and all broader measurements must be rerun
on the frozen post-retarget final head.

### Interim post-retarget dirty-worktree measurements

The focused workload was rerun after retargeting onto the actual #1097 merge,
but before the implementation was committed and frozen:

```bash
scripts/dev-shell.sh -- npx tsx benchmarks/run.ts --host=node \
  --suite=spawn-scratch --rounds=3
scripts/dev-shell.sh -- npx tsx benchmarks/run.ts --host=browser \
  --suite=spawn-scratch --rounds=3
```

The environment reported Node.js `v24.15.0`, Playwright `1.61.0`, and Google
Chrome for Testing `149.0.7827.55`.

| Host | Ordinary spawn | Wire bytes | First large spawn | Repeated large spawn | Retained scratch | Kernel memory |
|---|---:|---:|---:|---:|---:|---:|
| Node | 51.24 ms | 84,386 | 49.24 ms | 48.25 ms | 84,386 bytes | 17,694,720 bytes |
| Chromium | 17 ms | 84,386 | 15 ms | 14 ms | 84,386 bytes | 17,694,720 bytes |

The Node result is
`benchmarks/results/benchmark-node-1785070891966.json`, SHA-256
`2f5c6ec009829d2710f0106d1a0166fa3371e80810935d0bfeef553cee117026`.
The Chromium result is
`benchmarks/results/benchmark-browser-1785070900428.json`, SHA-256
`29aa9ff74f3a7c81905e308eb01e715ce39430648a00e9bd51bd5b89722e03a4`.
Both identify checked-out Git head
`2e0b32d3e1620c8eb68c41999148824ceb3ccea8`, but the measured source was
dirty. The runtime fingerprints therefore identify the actual inputs:

- kernel Wasm: 644,386 bytes, SHA-256
  `691a1ceedce21e9bce4c1eda09f646092f6c5c1c89311d70e3cc5debc5ada6a8`;
- `host/src`: 109 files, 2,775,329 bytes, SHA-256
  `1add5d34a592498552e50b9cbe64fc15008890cbe215c092cba61caefd0d4d0f`;
- spawn fixture: 38,373 bytes, SHA-256
  `b7dc5d5bc37aaafd5f384750efbfe10c89cf84de416b55cc40edc6a61c009de0`;
- Node worker bundle: 1,264,520 bytes, SHA-256
  `764ee4d1fdb22965bc6b1270ab1c3d04a250a931bf9a17439cfb617eac4824ea`.

This post-retarget run again retained only 84,386 scratch bytes instead of the
historical fixed 8,417,320 bytes, and kernel linear memory remained 127 pages
below the comparable fixed-buffer workload. It is memory-sizing evidence for
the measured inputs, not exact committed-head evidence and not a latency
claim.

### Exact-PR-head measurement recording contract

After the PR head is frozen, its external validation ledger must record the
exact commit SHA, fresh source/artifact fingerprints, and the same Node and
real-Chromium measurements. Keeping that mutable evidence in the PR description
avoids changing the commit merely to embed its own SHA here. The ledger must
distinguish the historical exact-#1094 baseline from the final ABI-43
implementation and must not claim a timing improvement from three-round
samples.

## ABI decision

`ABI_VERSION` is 43 in the post-retarget implementation:

- Generated spawn wire values and accepted limits remain byte-for-byte
  identical. Moving those constants to the existing generation path would not
  require a bump by itself.
- `kernel_handle_channel` now accepts the complete channel capacity as its
  second argument and rejects any value other than the canonical allocation
  size. Its signature changes from the ABI-42 two-argument form to
  `(channel_offset, channel_capacity, pid)`, so old hosts and kernels cannot be
  mixed.
- The process-channel signal area is one generated 56-byte delivery record for
  both caller widths, replacing the ABI-42 44-byte delivery payload inside a
  48-byte reserved channel area. It carries raw eight-byte `si_value` bits,
  `si_code`, sender or
  timer metadata, and the alternate-stack fields. The C trampoline copies only
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
- `kernel_timer_create` changes from
  `(clock_id, sigevent_ptr, timerid_ptr)` to
  `(clock_id, sigevent_ptr, timerid_ptr, process_pointer_width)`. The fourth
  parameter is an `i64` host-private dispatch value in the Wasm export
  signature. It selects the complete 64-byte caller-native `sigevent` layout
  and preserves `union sigval` as raw `u64` bits, including a wasm64 pointer.
  Timer, queued-signal, plain sender, and `SI_MESGQ` metadata now remain intact
  through dequeue and native `siginfo_t` reconstruction.
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
- The host-adapter manifest continues to require `kernel_spawn_process` and
  now also requires `kernel_spawn_reserved_process`,
  `kernel_clear_process_metadata`,
  `kernel_push_process_metadata_entry`, `kernel_set_cwd`,
  `kernel_spawn_scratch_begin`, `kernel_spawn_scratch_pointer`,
  `kernel_spawn_scratch_capacity`,
  `kernel_spawn_scratch_retained_capacity`, `kernel_spawn_scratch_cancel`,
  `kernel_msqid_ds_bytes`, `kernel_semid_ds_bytes`,
  `kernel_semctl_array_bytes`, and `kernel_shmid_ds_bytes`. A same-version
  kernel missing them fails loudly rather than entering a legacy path.
- The three `*_ds_bytes(process_pointer_width)` exports and the host-private
  sixth dispatch slot make the caller's wasm32/wasm64 data model authoritative
  for `msqid_ds` (96/120 bytes), `semid_ds` (72/88), and `shmid_ds` (88/112).
  Semaphore GETALL/SETALL use the separate
  permission-aware exact-size export; there is no read-only `IPC_STAT`
  compatibility fallback.
- `KernelScratchRegion` remains an internal TypeScript value, but that fact
  does not neutralize the required export and synchronization changes.

PR #1097 merged as
`c7d039794a43788acfa0b0aea30a700c257f57cb` with ABI 42. Retargeting is
complete, so ABI 43 is the decided epoch for these incompatible changes. The
current Rust source, generated TypeScript consumer, and ABI snapshot declare
ABI 43, and generated TypeScript includes the request-aware ioctl table.
Generated-file freshness, the ABI classifier, and the snapshot must pass in
check mode on the exact PR head named by the external validation ledger.

## Historical and interim validation evidence

All commands recorded in this ledger ran through `scripts/dev-shell.sh`.
The subsection labels distinguish historical pre-retarget evidence from
current post-retarget dirty-tree evidence. Results inside either category do
not all describe one source fingerprint, and artifact-sensitive results
identify their inputs above. None is presented as an exact frozen final-head
run.

### Interim post-retarget evidence, not final

- `scripts/dev-shell.sh -- bash build.sh` passed the complete declared build:
  the kernel, both-width program fixtures, host bundles, and an ABI-43 root
  filesystem. Before that final run, both
  `scripts/build-musl.sh` and `scripts/build-musl.sh --arch wasm64posix`
  passed, as did `scripts/build-programs.sh`.
- `scripts/dev-shell.sh -- cargo build --release -p kandelo --target
  wasm64-unknown-unknown -Z build-std=core,alloc` passed the explicit wasm64
  kernel build. It emitted existing target/conditional dead-code and
  unused-variable warnings, not build errors.
- `scripts/dev-shell.sh -- bash scripts/check-abi-version.sh` passed check mode.
  It matched the IPC, native-process, and fixed-process layouts for wasm32 and
  wasm64; confirmed all six generated ABI outputs are fresh; and verified that
  the snapshot change accompanies the `ABI_VERSION` bump to 43.
- The focused scratch/runtime Node matrix passed 11 files and 425 tests:

  ```bash
  scripts/dev-shell.sh -- npm --prefix host exec vitest -- run \
    test/generated-abi.test.ts \
    test/kernel-scratch-contract.test.ts \
    test/wasm-memory-write-audit.test.ts \
    test/kernel-scratch-region.test.ts \
    test/kernel-public-scratch.test.ts \
    test/kernel-scratch-transfer-boundaries.test.ts \
    test/kernel.test.ts \
    test/process-native-layout.test.ts \
    test/timerfd-signalfd-scratch.test.ts \
    test/scm-rights-pipe-lifetime.test.ts \
    test/scm-rights-semantics.test.ts
  ```

  The 189 transfer-boundary cases cover both pointer widths. The four
  real-compiled-kernel cases include mqueue and child-wait exact-capacity
  contracts. The wait-child case rejects null and capacities 159/161 without
  consuming the child or changing canaries, accepts exact capacity 160 and
  reaps the child, then receives `ECHILD`.
- A separate canonical host-directory process/spawn batch passed 8 files and
  181 tests:

  ```bash
  scripts/dev-shell.sh -- bash -lc 'cd host && npm test -- --run \
    test/spawn-blob-transport.test.ts \
    test/exec-state-tracking.test.ts \
    test/process-wait-lifecycle.test.ts \
    test/readiness-deadline.test.ts \
    test/advisory-lock-kernel.test.ts \
    test/signal-accept-livelock.test.ts \
    test/multi-worker.test.ts \
    test/host-adapter-manifest.test.ts'
  ```

  An initial noncanonical invocation ran `multi-worker.test.ts` from the
  repository root and failed two relative `../Cargo.toml` opens with `ENOENT`;
  the exact canonical rerun above passed both. That invocation-context failure
  is not a runtime or scratch failure.
- After the adversarial review found the wrapper-generation defect,
  `kernel-initialization-lifetime.test.ts` passed all four wasm32/wasm64,
  reinit, concurrency, and failed-retry cases. The accompanying focused
  public-scratch/input-snapshot/lifetime batch passed 54 tests.
- After closing the direct pointer-export audit gap,
  `wasm-memory-write-audit.test.ts` passed 67 focused analyzer cases. The
  repository-wide `kernel-scratch-contract.test.ts` audit passed its selected
  contract case in 26.56 seconds with a 60-second CI timeout. It now traces
  wrapped callable provenance to the one reviewed lease-core raw invocation;
  no production pointer-bearing export bypass remains allowlisted.
- `scripts/dev-shell.sh -- npm --prefix host run typecheck` passed declaration
  generation.
- `scripts/dev-shell.sh -- cargo test --target aarch64-apple-darwin -p
  kandelo` passed 1,344 unit tests, four pointer-contract integration tests,
  and six compile-fail documentation tests.
- `scripts/dev-shell.sh -- cargo test --target aarch64-apple-darwin -p
  wasm-posix-shared` passed 37 shared-contract tests, and
  `scripts/dev-shell.sh -- cargo check -p wasm-posix-shared` passed with only
  the toolchain's unstable-atomics target-feature warning.
- `scripts/dev-shell.sh -- cargo test -p xtask --target
  aarch64-apple-darwin dump_abi::tests` passed 21 generator tests, and
  `scripts/dev-shell.sh -- bash scripts/test-resolve-binary-bundle.sh` passed
  the standalone generated-bundle freshness check.
- Two focused Playwright commands drove real Chromium with one worker. The
  scratch-runtime, path, file-limit, native-layout, terminal, and 16-case
  two-width `SCM_RIGHTS` semantic group passed 23 tests. The two-width
  child-wait and FIFO/SCM pipe-lifetime group passed another five. Total
  focused browser evidence is eight spec files and 28 passed tests. Vite
  reported that it could not prebundle optional application imports, but the
  minimal self-contained test runner loaded and every listed assertion ran.
- The libc, Open POSIX, and Sortix runners were attempted through their normal
  entry points. The exact pre-kernel artifact-closure results are recorded in
  “Open evidence gaps” above; none is counted as a conformance pass or a
  scratch test failure.
- `scripts/dev-shell.sh -- cargo fmt --all -- --check` remains blocked with
  `error: no such command: fmt`; no undeclared host formatter was used.
- The post-retarget Node and real-Chromium spawn-scratch measurements passed
  three fresh-worker rounds each. Their values and runtime fingerprints are in
  “Interim post-retarget dirty-worktree measurements.”

Every result in this subsection was produced from the current dirty
post-retarget source, not a frozen commit. It must be repeated as appropriate
on the exact final head.

### Historical pre-retarget and dirty-worktree evidence

- `bash scripts/dev-shell.sh bash build.sh`: passed the complete declared build,
  including the wasm32 kernel, wasm32/wasm64 guest programs, the TypeScript
  host, and the root filesystem.
- `bash scripts/dev-shell.sh cargo build --release -p kandelo --target
  wasm64-unknown-unknown -Z build-std=core,alloc`: passed an explicit wasm64
  kernel build from the frozen Rust source.
- `scripts/dev-shell.sh -- cargo test --target aarch64-apple-darwin -p
  kandelo`: the historical pre-retarget dirty-worktree run passed all 1,343
  native kernel unit
  tests, four integration tests, and six documentation tests. This includes
  the exact 56-byte signal record, invalid mqueue notification signums,
  full-width signal metadata, and self-sender metadata regressions.
- `bash scripts/dev-shell.sh cargo test --target aarch64-apple-darwin -p
  wasm-posix-shared` passed all 36 shared-crate unit tests, and
  `bash scripts/dev-shell.sh cargo check -p wasm-posix-shared` passed.
- `bash scripts/dev-shell.sh cargo check -p kandelo --target
  wasm32-unknown-unknown -Z build-std=core,alloc` passed the explicit wasm32
  kernel check. These are source/crate checks, not browser or full runtime
  evidence.
- `bash scripts/dev-shell.sh cargo test --target aarch64-apple-darwin -p kandelo
  --test wasm_api_channel_pointer_contract`: four
  integration tests passed. These are source-contract checks over the Wasm API
  dispatcher and zero-length `sendmsg` guard, not a wasm-target runtime
  execution.
- An earlier `bash scripts/dev-shell.sh bash scripts/check-abi-version.sh` run
  passed the ABI classifier and snapshot, generated Rust/TypeScript/C freshness
  checks, and the wasm32/wasm64 native-layout checks. After the signal export
  and channel-layout changes, `scripts/dev-shell.sh -- bash
  scripts/check-abi-version.sh update` again passed both native-layout checks,
  the kernel build, and regeneration. Check mode still requires a frozen-head
  rerun; update mode is not substituted for that final freshness/classifier
  evidence.
- `scripts/dev-shell.sh -- cargo test --target aarch64-apple-darwin -p xtask
  dump_abi::tests::generated_native_process_layout_contract_matches_both_musl_targets`
  and the corresponding
  `dump_abi::tests::generated_channel_contract_covers_status_layout_and_signal_wire`
  case passed against the generated native layouts and 56-byte channel signal
  wire.
- `scripts/dev-shell.sh -- npm --prefix host test -- --run
  test/kernel-scratch-transfer-boundaries.test.ts -t "fails closed when the
  mqueue notification drain returns an errno"` passed its one selected case.
  It proves `-EINVAL` publishes neither a wake nor a signal; the other 188
  cases in that file were intentionally skipped by the name filter.
- `scripts/dev-shell.sh -- npm --prefix host test -- --run test/kernel.test.ts
  -t "requires a nonnull exact-capacity mqueue notification destination"`
  passed its one selected real-Wasm case. It seeds one live notification
  through `mq_notify`/`mq_timedsend`, rejects pointer zero and capacities 7/9
  without consuming or mutating it, then accepts capacity 8, returns the
  expected PID/signum, and preserves both destination canaries.
- `scripts/dev-shell.sh -- npm --prefix host test -- --run
  test/process-native-layout.test.ts` passed both wasm32 and wasm64 cases after
  the latest full rebuild. Those cases now exercise 56-byte `SA_SIGINFO`
  delivery, native C reconstruction, queued/timer/mqueue values, sender
  metadata, and invalid `mq_notify` signums. This is Node evidence only;
  Chromium remains pending.
- `bash scripts/dev-shell.sh npm --prefix host exec vitest -- run
  test/generated-abi.test.ts
  test/kernel-scratch-transfer-boundaries.test.ts` passed 195 tests on the
  regenerated TypeScript ABI consumer. Of those, 188 are the transfer-boundary
  cases covering wasm32/wasm64 positive null, owned empty, fixed-output null,
  option-sensitive `prctl`, null nested length, reordered `Deref`, vector and
  message capacity, shared-memory allocator identity, and the other
  caller/allocation boundaries inventoried above.
- The historical broader focused host matrix passed 255 tests:

  ```bash
  scripts/dev-shell.sh npm --prefix host exec vitest -- run \
    test/wasm-memory-write-audit.test.ts \
    test/kernel-scratch-contract.test.ts \
    test/kernel-scratch-region.test.ts \
    test/kernel-public-scratch.test.ts \
    test/spawn-blob-transport.test.ts \
    test/centralized-spawn.test.ts \
    test/spawn-host-parity.test.ts \
    test/host-process-pointer-width.test.ts
  ```

  This matrix includes the 64-case compiler-backed analyzer and the
  three-case repository scratch contract, plus region, public wrapper, spawn
  transport, spawn lifecycle/parity, and pointer-width coverage. It is focused
  Node evidence, not the complete host suite or a browser claim. Both focused
  commands remain rehearsal evidence and must be repeated on the frozen
  post-retarget head.
- The historical broader integration matrix passed 29/29 files and 679/679
  tests:

  ```bash
  scripts/dev-shell.sh npm --prefix host exec vitest -- run \
    test/kernel-scratch-contract.test.ts \
    test/wasm-memory-write-audit.test.ts \
    test/kernel-scratch-region.test.ts \
    test/kernel-scratch-transfer-boundaries.test.ts \
    test/kernel-public-scratch.test.ts \
    test/spawn-blob-transport.test.ts \
    test/pathconf.test.ts \
    test/file-shared-memory.test.ts \
    test/process-native-layout.test.ts \
    test/sysv-ipc.test.ts \
    test/timerfd-signalfd-scratch.test.ts \
    test/kernel-worker-copyback.test.ts \
    test/deferred-worker-start.test.ts \
    test/kernel-wasm-input-snapshot.test.ts \
    test/host-process-pointer-width.test.ts \
    test/program-fixture-freshness.test.ts \
    test/compiled-worker-entry.test.ts \
    test/clone-tid-authority.test.ts \
    test/exec-state-tracking.test.ts \
    test/process-wait-lifecycle.test.ts \
    test/shared-memory-coherence.test.ts \
    test/generated-abi.test.ts \
    test/abi-version.test.ts \
    test/host-adapter-manifest.test.ts \
    test/terminal-attributes-api.test.ts \
    test/centralized-spawn.test.ts \
    test/spawn-host-parity.test.ts \
    test/spawn-pid-authority.test.ts \
    test/advisory-lock-kernel.test.ts
  ```

  This exact rerun includes the shared-memory allocator-identity regression
  and every repaired wait-result pointer-plus-capacity expectation. It is
  historical dirty-worktree Node evidence, not the complete host suite or a
  browser claim.
- `scripts/dev-shell.sh npm --prefix host run typecheck` passed the
  pre-retarget dirty-worktree host declaration build.
- `bash scripts/dev-shell.sh npx tsx --test
  benchmarks/artifact-selection.test.ts benchmarks/timeout.test.ts`: 13
  benchmark artifact-selection, timeout, and spawn-evidence contract tests
  passed.
- The generated package-index projection and its source-context check passed
  through the worktree's declared native `xtask` with:

  ```bash
  bash scripts/dev-shell.sh target/aarch64-apple-darwin/release/xtask \
    build-deps program-index packages/registry \
    packages/registry/program-packages.json
  bash scripts/dev-shell.sh target/aarch64-apple-darwin/release/xtask \
    build-deps program-index-context-check --source-repo-root "$PWD"
  ```

  The exact-source projection has SHA-256
  `538c269f8a4e86305929db6358176a38f4855cb6be9d83e324b1c4028db20fa0`
  and is committed because leaving the base projection in place makes the
  package-build-root contract fail as stale after the ABI/source changes.
- `bash scripts/dev-shell.sh bash scripts/test-package-build-roots.sh`: passed
  after regenerating the projection. The first CI run exposed the stale
  projection honestly; no freshness bypass or test exception was added.
- `bash scripts/dev-shell.sh npx tsx benchmarks/run.ts --host=node
  --suite=spawn-scratch --rounds=3` and the corresponding `--host=browser`
  command both passed. The browser command drove real Chromium. This evidence
  covers only the self-contained spawn workload; the exact result files and
  fingerprints are recorded in the sizing section.

Before the fixtures opted out of the default root filesystem, artifact policy
correctly rejected an ABI-mismatched rootfs before any assertion ran: first for
the timer/signalfd cases, and later for the two process-native-layout plus two
System V IPC cases. These tests execute self-contained binaries and require no
rootfs contents, so they now pass `useDefaultRootfs: false`. The default-rootfs
policy itself was not weakened; tests that request that artifact still require
an ABI-matching image.

### Exact final-head gates

No dirty-worktree result above is substituted for these gates. The mutable
draft PR ledger must record:

- exact final head SHA plus source, generated-file, kernel Wasm, worker-bundle,
  guest-fixture, and benchmark-input fingerprints;
- the complete declared build and selected native/shared kernel suites;
- ABI check mode, generated-file freshness, ABI classifier, and committed
  snapshot checks;
- the focused and broader Node matrices, including the real-Wasm
  `kernel_wait_child_poll` exact-capacity regression;
- real Chromium execution of the exact relevant specs, including scratch
  runtime, process-native layout, wait lifecycle, and all 16 `SCM_RIGHTS`
  semantics cases plus the two pipe-lifetime cases;
- another normal attempt at the blocked Sortix, libc, and Open POSIX coverage
  if the ABI-43 package closure becomes available;
- final Node and real-Chromium retained-memory and timing measurements described
  in the recording contract above.

### Historical blockers and uncompleted coverage to reprobe

- From `apps/browser-demos`,
  `../../scripts/dev-shell.sh env CI=1 KANDELO_PLAYWRIGHT_PORT=15466
  npx playwright test test/terminal-attributes-api.spec.ts
  test/wait-lifecycle.spec.ts test/environment-lifecycle.spec.ts
  test/opfs-advisory-lock.spec.ts --project=chromium` stopped during Vite
  startup because the program graph rejected stale ABI-42 `bzip2.wasm`.
  No assertion ran; after the blocked setup was interrupted, one test was
  reported interrupted and five did not run. This is neither a Chromium pass
  nor a changed-runtime failure.
- The historical pre-retarget `SCM_RIGHTS` Chromium attempt stopped before
  guest launch on the authored-application graph. The post-retarget focused
  minimal-dependency command supersedes that narrow gap: all 16 semantic and
  both pipe-lifetime cases now pass. It does not unblock the broad application
  graph or make the historical stopped run a pass.
- Sortix, libc-test, and Open POSIX were each reprobed normally and stop before
  guest execution on the same incomplete one-tier ABI-43 artifact closure.
  Exact counts and the direct resolver diagnostic are recorded above. No
  resolver bypass or test-only exception was used.
- The performance guide's complete application suites remain blocked by
  unavailable ABI-43 PHP, WordPress, and MariaDB artifacts. The focused timing
  sample is not substituted for those suites.
- `bash scripts/dev-shell.sh cargo fmt --all -- --check` could not start:
  the declared shell reports `error: no such command: fmt`. The discovered
  Homebrew formatter is undeclared and was not used.
PR #1097 is merged and retargeting is complete. The focused Chromium and
retained-capacity results above remain historical/interim evidence rather than
complete-application evidence. No approval may be requested and no merge may
occur unless the draft PR's validation ledger names its current exact head and
reports the required reruns and external blocks truthfully.
