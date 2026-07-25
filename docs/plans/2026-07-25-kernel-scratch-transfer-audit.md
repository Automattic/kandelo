# Kernel Scratch Transfer Audit

Status: source inventory and the rehearsal implementation are complete on a
branch based on exact PR #1094 head
`6d923c6454dd7174082f25c3d3991d03f86f5ddb`. Current-tree rehearsal
validation is recorded below. PR #1094 was closed without merging after this
work began, and its main-first replacement, PR #1097, has not yet merged.
Final-base validation therefore has not begun. This branch must be retargeted
and revalidated against #1097's actual merged result before it can be presented
as ready, and it must not be merged from this base.

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

The tables distinguish three kinds of evidence:

- **Confirmed unsafe** means the old source admits the transfer and the focused
  reproduction demonstrates the missing ownership, capacity, range, or
  conversion proof.
- **Implemented; validation pending** means the current source contains the
  stated proof and a focused regression exists, but the final generated
  artifacts and final-base test ledger are not yet complete.
- **Uncertain** means source inspection has not yet been paired with executable
  evidence sufficient for a safe disposition. Uncertainty is not treated as
  safety.

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

- `KernelScratchRegion` privately carries `memory`, `pointer`, pointer width,
  and a diagnostic label while exposing only `capacity`. Its private
  constructor means production regions come only from
  `allocateKernelScratchRegion` or `reserveKernelScratchRegion`; callers
  inside the repository runtime cannot recover a bare region pointer outside
  an active lease.
  Reservation-derived regions are single-use and explicitly revoked when
  their Rust token is consumed or cancelled, so a later `Vec` growth cannot
  revive a stale pointer/capacity pair.
- `KernelScratchLease` is the only read/write interface. Every operation
  rechecks non-negative safe-integer offsets and lengths, allocation capacity,
  pointer arithmetic, pointer width, and the current memory buffer. Bulk
  sources are normalized through intrinsic typed-array slots before the native
  `set`; subclass getters and `subarray` overrides cannot lie about their span.
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
TypeScript compiler and type checker discover production and selected
diagnostic sources recursively, seed their ownership roots, and propagate
kernel-memory ownership through aliases, helper parameters and returns,
spreads, destructuring, logical/comma expressions, loop bindings, and common
intrinsic array element/callback methods. They report raw typed/DataView
construction, scalar and bulk writes, escapes, persistent stores, returned
views, allocator calls, and spawn-reservation calls. An exact multiset
allowlist admits only named reviewed occurrences with inline reasons; adding or
duplicating an occurrence fails, and deleting one makes its allowance stale
and also fails. Framebuffer, process-memory, Rust-lent, and explicit
shared-backing roots remain separately classified because their owner is not
the kernel scratch allocator. A `.set` or `.decode` call counts as a
synchronous reader only when TypeScript resolves it to the native typed-array
or `TextDecoder` declaration; a same-named custom method remains an escape.
This is a compiler-backed contract over the reviewed repository source, not a
claim of a sound general-purpose JavaScript taint analysis or control over raw
writes performed by a downstream consumer through the unsafe trusted-embedder
accessors.

## Allocation inventory

“Final disposition” records the implemented design target in this rehearsal;
it is not a readiness claim until the post-#1097 validation ledger is complete.

| Region and symbols | Allocating owner; pointer/capacity | Maximum accepted source | Lifetime and overlap | Hosts / widths | Audited-head disposition | Final disposition |
|---|---|---|---|---|---|---|
| Raw allocator boundary, `crates/kernel/src/wasm_api.rs::kernel_alloc_scratch`; `crates/kernel/src/scratch_alloc.rs::layout` | Rust global allocator; successful pointer owns exactly the validated `Layout` size | The export accepts a `u32` request, but a successful allocation is further bounded by the aligned Rust `Layout`/`isize::MAX` domain | Allocation is retained for the kernel lifetime; no host-side free or growth workaround | Node/browser; wasm32/64 kernel | **Unsafe failure boundary.** Invalid `Layout` construction could trap instead of reporting allocation failure | **Implemented; validation pending.** Zero/invalid layouts and allocator-null return zero; the host rejects an invalid zero or out-of-memory-range result before constructing a region |
| Main syscall scratch, `CentralizedKernelWorker.scratchRegion` | Rust `kernel_alloc_scratch`; `KernelScratchRegion`, 65,608 bytes (`CH_TOTAL_SIZE`) | Each layout is checked against the region; ordinary data payload is at most 65,536 bytes (`CH_DATA_SIZE`) | Kernel lifetime; one synchronous lease per dispatch/copy; nested leases fail | Node and browser; wasm32/64 kernel | **Unsafe contract.** Bare `scratchOffset`; several live overflows | **Implemented; validation pending.** All allocator-owned access is lease-mediated |
| TCP/pipe scratch, `tcpScratchRegion`, `requireTcpScratchRegion` | Rust `kernel_alloc_scratch`; `KernelScratchRegion`, 65,536 bytes | One checked network/pipe chunk, at most 65,536 bytes | Kernel lifetime; worker callbacks/messages detach bytes before yielding | Node/browser; wasm32/64 kernel | **Safe sizes, weak contract.** Private pointer reached other code | **Implemented; validation pending.** Region stays private and all access is synchronously leased |
| Large spawn scratch, `beginLargeSpawnScratch`, `SpawnScratchBuffer` | Rust `Vec<u8>` through required `kernel_spawn_scratch_begin/pointer/capacity/cancel`; the returned token gates both pointer and capacity, while separate pointer-free retained-capacity telemetry grants no write authority | Complete blob at most 8,417,320 bytes; ordinary blobs use main scratch | Kernel-lifetime high-water allocation, but a fresh exclusive token and single-use host region per operation. Begin and queries are nonblocking; begin may move only while idle. After every successful begin, host cleanup runs in `finally`. Commit/cancel wait on the same no-import lock and return with a definitive token state; cleanup failure is fatal and leaves the host reentry guard closed | Node/browser; wasm32/64 kernel | **Safe after #1094, weak contract.** Fixed 8,417,320-byte allocation retained after first large use | **Capacity-safe design and focused rehearsal Node/Chromium measurement complete; exact final-base validation pending.** `kernel_spawn_reserved_process` accepts token+length rather than a bare pointer; no ABI-42 fallback |
| Audio drain, `WasmPosixKernel.audioScratchRegion` | Rust `kernel_alloc_scratch`; 65,536-byte `KernelScratchRegion` | `min(out.byteLength, capacity)` and checked Rust return count | Kernel lifetime; one synchronous drain lease | Node/browser; wasm32/64 kernel | **Uncertain.** Pointer/range and producer count were incomplete | **Implemented; validation pending.** Allocation, requested bytes, current range, and returned count are checked |
| Public wrapper temporary storage, `apiScratchRegion` | Rust `kernel_alloc_scratch`; 65,536-byte `KernelScratchRegion` | Each socket/poll/terminal/ioctl/uname/pipe/rusage/select request must fit | Kernel lifetime; synchronous public-call lease | Node/browser; wasm32/64 kernel | **Unsafe.** Hard-coded addresses 4 and 16 were not allocations | **Implemented; validation pending.** All temporary public API storage is allocator-owned |
| Rust-lent host-import destinations, `checkedWasmImportMemoryRange`, `readKernelBytes`, `writeKernelBytes` | Rust slice/local/struct; pointer plus explicit capacity, or a generated authoritative fixed-format size such as the 68-byte KMS mode record, for one import call | Genuine producer span no larger than the Rust-supplied or generated capacity | Only the synchronous import; backend data is staged in host-owned memory and no kernel view is lent or retained | Node/browser; wasm32/64 kernel | **Valid ownership, incomplete checks.** Lossy conversions, live-view lending, and clamping writes existed | **Implemented; validation pending.** Signed-wasm32/wasm64 pointer normalization, complete range, intrinsic producer span, detached/staged backend I/O, and producer/result length precede one publish |
| Unsafe trusted-embedder accessors, `WasmPosixKernel::{getMemory,getInstance}` and `CentralizedKernelWorker::{getKernel,getKernelInstance}` | Exposes the complete raw kernel memory/instance, not a capacity-bearing allocation | Unrestricted by design; consumers are trusted to uphold the kernel ABI | Repository transfer code does not use this path; external direct mutation has no lease or overlap guarantee | Node/browser; wasm32/64 kernel | Existing public low-level/debug API | **Reviewed out-of-contract boundary.** Explicitly documented as unsafe; the static repository audit does not claim to control downstream raw-memory writes |

## Transfer inventory

“Synchronous” below means that no promise, worker-message yield, or callback
boundary can occur while Rust is expected to consume the staged bytes.
Single-threaded event-loop execution is not used as a substitute for capacity
or range validation. As above, final dispositions describe the implementation
target and still require final-base validation.

| File / exact symbols | Owner; pointer and declared capacity | Maximum accepted source and origin | Capacity, range, and pointer proof | Synchronous use / overlap | Hosts / widths | Audited-head disposition | Current-source disposition |
|---|---|---|---|---|---|---|---|
| `host/src/kernel.ts::{intrinsicBufferSourceSpan,bufferSourceToArrayBuffer,init,initWithMemory}` | Caller supplies kernel module bytes; the host immediately owns one detached `ArrayBuffer` snapshot | Exact intrinsic `ArrayBuffer`, typed-array, or `DataView` byte window accepted by the WebAssembly compiler | Captured native internal-slot getters reject non-genuine/detached sources and ignore subclass span getters; pointer-width detection and compilation consume the same snapshot | Snapshot completes before the asynchronous compile; later caller mutation cannot replace either consumer's bytes | Node/browser; kernel wasm32/64 | **Confirmed pointer-width trust-boundary defect.** A view subclass could make width detection parse decoy bytes while the engine compiled its intrinsic bytes | **Implemented; validation pending.** Spoofed typed-array and nonzero-window DataView regressions prove identical compile/detection bytes |
| `host/src/kernel-worker.ts::replaceProcessMetadata` | Rust main allocation; private `scratchRegion`, 65,608 bytes; payload begins at `CH_DATA` | One metadata entry at most `CH_DATA_SIZE` (65,536); exec argv/environment aggregate at most generated `ARG_MAX` | Detached caller bytes; lease proves owned allocation and current memory; Rust return count is bounded | One lease and Rust call per entry; view is reacquired after possible growth; no overlap | Node/browser; kernel and guest wasm32/64 | Sizes fit, but a bare pointer represented ownership | **Implemented; validation pending.** Lease-mediated staging |
| `host/src/kernel-worker.ts::{handleExec,handleExecveat,readExecPathFromProcess,readStringArrayFromProcess,resolveExecPathAgainstCwd}` | Exec pathname/argv/environment are detached JS strings read from caller process memory; only CWD/fd-path queries use the 65,608-byte main allocation | Path scan is bounded by generated `PATH_MAX` 4,096; each string by 65,536; complete argv/environment representation, including pointers and NULs, by generated `ARG_MAX` 4 MiB; CWD/fd-path output by 4,096 | Native pointer-array entries are read at guest width and wasm64 values must be losslessly representable; every string must terminate in its caller range; `captureMainScratchOutput` passes exact pointer/capacity and checks Rust's count | No scratch view crosses `callbacks.onExec`'s promise; only detached strings/arrays do. Each CWD/fd-path query completes its lease before the callback | Node/browser; guest wasm32/64 independent of kernel width | **Unsafe/uncertain edge.** Async exec and bounded-string paths used bare scratch queries and lossy/incomplete pointer scans | **Implemented; validation pending.** Explicit `PATH_MAX`/`ARG_MAX`, lossless native-pointer, and no-view-across-promise contract |
| `host/src/kernel-worker.ts::{ptyMasterWrite,ptyMasterRead}` | Rust main allocation, full 65,608-byte region | Write chunks are `min(remaining, lease.capacity)`; read request is `min(4,096, lease.capacity)` | Write source slice and destination are independently checked; returned write/read count must be a safe integer no larger than the offered chunk/request | One lease per chunk/call; read bytes are detached before `drainPtyOutput`; a second operation cannot enter the active lease | Node/browser; kernel wasm32/64 | **Confirmed unsafe.** `ptyMasterWrite` copied arbitrary `data.length` into the allocation; read trusted the producer count | **Implemented; validation pending.** Exact 65,608 and 65,609 regression |
| `host/src/kernel-worker.ts::setCwd` | Rust main allocation, 65,608 bytes | Encoded path must be shorter than generated `POSIX_PATH_MAX_BYTES` (4,096, including the NUL contract) | Length is rejected before acquiring/copying; lease then proves allocation and current-memory bounds | One synchronous lease and `kernel_set_cwd` call; no retained view | Node/browser; kernel wasm32/64 | **Confirmed unsafe.** Copy happened before Rust's `PATH_MAX` rejection | **Implemented; validation pending.** Pre-copy oversized-CWD regression |
| `host/src/kernel-worker.ts::{enumProcs,readProcMaps,captureMainScratchOutput}`; Rust exports `kernel_get_cwd`, `kernel_get_fd_path`, and wait/wake/mqueue query helpers | Rust main allocation, 65,608 bytes | Fixed or explicit producer requests, presently no more than 4,096 bytes for paths and 1,280 bytes for listed fixed records | Requested capacity is passed to Rust; returned byte/count value must be safe and fit that capacity before `copyOut` | Producer runs inside one lease; detached bytes cross any callback/retry boundary | Node/browser; kernel/guest wasm32/64 | Fixed requests fit; several producer counts were trusted | **Implemented; validation pending.** `captureMainScratchOutput` or direct checked leases |
| `host/src/kernel-worker.ts::CentralizedKernelWorker::_handleSyscallInner`; `host/src/generated/abi.ts::SYSCALL_ARGS`; `crates/shared/src/host_abi.rs::SyscallArgSize::{Fixed,Arg,ArgTimes,CString,ProcessLayout}` | Rust main allocation; channel is 72 bytes and data capacity is exactly 65,536 | Sum of all descriptor-sized arguments, including alignment, must fit `CH_DATA_SIZE`; size expressions originate in generated shared ABI metadata and raw syscall counts | Negative, fractional, unsafe-integer, multiplication/addition overflow, required-null, complete process range, allocation capacity, and current-memory bounds are checked before the dispatch lease mutates scratch | Planning retains host-owned copies only; one lease stages, dispatches, snapshots output, and releases; nested or promise-escaping lease use fails | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe/uncertain domain edges.** Some raw pointers bypassed descriptors and staging was not ownership-bearing | **Implemented; validation pending.** Generic exact/capacity+1 and lease-time staging regressions |
| `host/src/kernel-worker.ts::{snapshotPlannedChannelOutput,completeChannel,handleBlockingRetry,handleSleepDelay}`; `PreparedChannelCompletion` | Output belongs to the just-completed main-scratch lease, but the only state allowed to outlive it is a detached `Uint8Array` plus its already-validated process destination | Exactly the output descriptors and successful byte counts captured before lease release; error and interrupted completions publish no staged output | `completeChannel` has no scratch-read fallback. Retry, timeout, stopped-process, signal, and teardown state accept only explicit detached writes; absent output means an empty list | Detachment occurs synchronously in the dispatch lease; later callbacks may overlap another scratch use without observing its bytes | Node/browser; guest/kernel wasm32/64 | **Confirmed lifetime defect.** Deferred completion could reread the shared allocation after another operation replaced it | **Implemented; validation pending.** Immediate-timeout poll, EAGAIN `recvmsg`, interrupted sleep, and stale-scratch regressions |
| `host/src/kernel-worker.ts::{PreparedChannelCompletion.deferredClone,failDeferredCloneLaunch}` | Caller process mailbox, not kernel scratch; the original four-byte parent-TID destination is validated and retained as a scalar | Exactly one `pid_t` word when the original clone requested `CLONE_PARENT_SETTID` | Rollback uses the captured `parentTidPointer`; it never rereads mutable flags or a replacement pointer from a parked mailbox | Parked completion may span worker construction and stop/continue callbacks, but retains no process or scratch view | Node/browser; guest wasm32/64 | **Confirmed deferred-lifetime defect.** Failure rollback reread mutable mailbox metadata and could clear a replacement address | **Implemented; validation pending.** Mailbox-replacement regression proves only the original word is cleared |
| `crates/shared/src/process_layout.rs`; `crates/shared/src/host_abi.rs::SyscallArgSize::ProcessLayout`; `crates/kernel/src/process_wire.rs::{read_*,write_*}` | Main data capacity 65,536; exact width-selected native record is the capacity passed to Rust | `stack_t` 12/24, kernel-facing `itimerval` 16/32, `mq_attr` 32/64, `sigevent` 64/64, `statfs` 88/120, `sysinfo` 312/368, and `siginfo_t` 128/128 | Host selects by guest pointer width in private slot 5, validates the full caller range, and stages exactly that size; Rust rejects widths other than 4/8 and non-exact slices; output padding/reserved bytes are zeroed | One dispatch lease; Rust serializes into the complete lent slice before copy-back | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe mixed-width/native-layout contract.** Fixed wasm32 or partial records truncated wasm64/full native records; stale `sysinfo` syscall 208 conflicted with musl 269 | **Implemented; focused rehearsal Node validation passed.** C layout drift, Rust exact/short/output-boundary, and end-to-end wasm32/wasm64 fixtures passed; browser and final-base validation remain pending |
| `crates/shared/src/host_abi.rs::SyscallArgSize::Fixed`; `crates/kernel/src/process_wire.rs::{write_stat,read_sched_param,write_sched_param}` | Main data capacity 65,536; the fixed native record size is part of the generated syscall descriptor | `stat` 112 bytes and `sched_param` 48 bytes on both supported caller widths | The descriptor proves the complete caller range and exact fixed capacity; these records do not use width selection or private slot 5 | One dispatch lease; Rust consumes or fills the complete fixed slice | Node/browser; guest wasm32/64 | **Confirmed partial-record contract.** Earlier descriptors did not name the complete musl object | **Implemented; validation pending.** Fixed-layout C drift checks and Rust exact/short tests |
| Generated `timerfd_settime`, `timerfd_gettime`, `signalfd`, and `signalfd4` descriptors; Rust checked channel-pointer consumers | Main data allocation; native timer records are 32 bytes and the signal mask is exactly eight bytes | Fixed generated record sizes; nullable old-timer output is the only optional timer pointer | Complete caller range, direction, nullability, allocation capacity/current memory, and Rust channel-pointer checks; the raw caller pointer never enters the kernel namespace | One dispatch lease; all input/output is detached at the normal completion boundary | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed address-domain defect.** Caller pointers were passed as kernel pointers | **Implemented; focused Node validation passed.** After rebuilding the ABI-43 kernel and host artifacts, the guarded caller-object fixture passed for wasm32 and wasm64; final-base and browser validation remain pending |
| `crates/shared/src/host_abi.rs` `Getaddrinfo` descriptor; `host/src/kernel-worker.ts::_handleSyscallInner`; `host/src/kernel.ts::hostGetaddrinfo` | Main data allocation; output capacity exactly four bytes, matching musl's private syscall result | Input is a required NUL-terminated name; name plus four-byte output must fit 65,536; host backend result must be exactly/fewer than the lent four bytes | Full caller name and four-byte output ranges; descriptor capacity and current memory; Rust and host import both receive explicit four-byte capacity | One dispatch lease and synchronous host import; four detached bytes are copied back | Node/browser; guest/kernel wasm32/64 | **Confirmed live caller overwrite.** Fixed 256-byte copy-back wrote 252 bytes beyond musl's four-byte result object | **Implemented; validation pending.** Four-byte result plus 252-byte canary regression |
| `host/src/kernel-worker.ts::handleGetgroups`; `crates/kernel/src/wasm_api.rs::kernel_getgroups(size,list_ptr,list_capacity_bytes)` | Rust main allocation; positive request lends one explicit four-byte gid slot; count query lends pointer/capacity zero | Kandelo currently returns exactly one supplementary gid; `size` accepts 0 through `INT_MAX`, but positive size never increases the lent capacity beyond four | Positive caller output range is exactly four bytes; kernel pointer and capacity are staged together; Rust rejects null or capacity below four; returned count must be safe, `<= size`, and `<= 1` | One lease; output is detached before reuse; zero-count query performs no pointer conversion | Node/browser; guest/kernel wasm32/64 | **Confirmed unsafe.** A raw process pointer crossed into the kernel address space and Rust wrote one `u32` without an allocation-capacity contract | **Implemented; validation pending.** Capacity 0/3/4/5, null, count-query, and detached-copy regressions |
| `crates/shared/src/host_abi.rs` `Setgroups` descriptor; `host/src/kernel-worker.ts::_handleSyscallInner` | Rust main data allocation, exactly 65,536 bytes | Count times four bytes; maximum one-call source is 16,384 gids from `CH_DATA_SIZE / sizeof(gid_t)` | Checked integer multiplication, complete caller source, descriptor layout, allocation capacity, current memory; count zero ignores the caller pointer and resolves a checked non-null empty scratch address under the final lease | One dispatch lease; no scratch view survives | Node/browser; guest/kernel wasm32/64 | **Unsafe address-domain contract, not a demonstrated live overwrite.** Bare caller pointer could enter the kernel namespace; current Rust did not dereference it | **Implemented; validation pending.** 16,384/16,385, zero-count high pointer, and positive null regressions |
| `crates/shared/src/ioctl_contract.rs::IOCTL_REQUEST_CONTRACTS`; `host/src/kernel-worker.ts::_handleSyscallInner` ioctl branch; `crates/kernel/src/wasm_api.rs::kernel_ioctl` | Rust main data allocation; pointer requests receive exact request-specific capacity; scalar/no-argument/unknown requests receive no scratch pointer | Pointer sizes are table-selected: 1–160 bytes in the current table, including `termios` 60 and `DRM_IOCTL_VERSION` 36 for wasm32 or 64 for wasm64 | Unsigned request lookup; exact guest-width size/direction; complete caller range; null and one-byte-short rejection; explicit `buf_len`; Rust repeats kind, width, exact length, null, and current-memory checks. `ScalarI32` requests canonicalize only their low 32 transport bits, so unspecified upper wasm64 C-vararg bytes neither become a pointer nor reach Rust. Known width-incompatible pointer requests return `EOVERFLOW` | One dispatch lease; no pointer is manufactured for scalar/no-arg/unknown requests | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe/incorrect.** Generic 256-byte staging/copy-back overran small caller objects and scalar values were treated as pointers; width-specific DRM layout was not represented | **Implemented; generated/runtime validation pending.** FIONREAD four-byte canary, exact 4/36/64, short/null, every scalar request with signed/unsigned and dirty-high-bit inputs, no-arg/unknown, and unsupported-width regressions |
| `host/src/kernel-worker.ts::{checkedNetworkIoctlProcessRange,handleIoctlIfconf,handleIoctlIfname,handleIoctlIfhwaddr,handleIoctlIfaddr,handleIoctlIfindex}` | Caller process memory, not kernel scratch; required outer `ifconf`/`ifreq` and the nested process buffer are caller-owned | Command-specific 8/16-byte `ifconf`, 32/40-byte `ifreq`, and `ifconf.ifc_len`; no shared-table maximum substitutes for the nested length | The shared checked process-range proof rejects a null/short outer object and checks the complete nested output range; the wasm64 nested pointer remains `bigint` until lossless conversion. Only `ifc_buf == 0` after a valid outer structure retains Linux size-query semantics | Synchronous host-side handling; no kernel scratch lease or retained view | Node/browser shared code; guest wasm32/64 | **Confirmed unsafe caller-boundary defect.** The former ad-hoc total-memory check accepted outer address zero, and the nested wasm64 pointer was narrowed before its proof | **Implemented; focused Node validation passed.** Exact and one-byte-short outer/nested ranges, capacity+1 output canaries, every network `ifreq` handler, null outer objects, and high/unsafe wasm64 non-aliasing passed in the 136-test focused transfer-boundary file; browser validation remains pending |
| `host/src/kernel-worker.ts::handleFcntlLock` | Rust main data allocation; 32-byte `struct flock` | Exactly 32 bytes | Full caller range, owned scratch range, current memory | One synchronous lease | Node/browser; guest/kernel wasm32/64 | Fixed size fit, bare pointer | **Implemented; validation pending** |
| `host/src/kernel-worker.ts::{handleSelect,handlePselect6}` | Rust main data allocation; three optional 128-byte fd sets plus timeout/mask records | `FD_SETSIZE`-derived fixed sets; optional eight-byte kernel mask and native timeout inputs | Every optional fd set, timeout, outer pselect sigmask descriptor, and nested mask range is checked before staging | Each attempt is synchronous; retry owns copies/scalars and no scratch view | Node/browser; guest/kernel wasm32/64 | **Confirmed unsafe caller-range paths** | **Implemented; validation pending.** Select/pselect boundary regressions |
| `host/src/kernel-worker.ts` generic `ppoll` descriptor planning and retry conversion | Main allocation/channel; 16-byte caller timespec and optional eight-byte signal mask become scalar kernel arguments | Fixed native records from syscall contract | Raw pointers remain bigint until lossless conversion; both complete caller ranges are proved on the first attempt and retry | Only final dispatch lease contains scratch bytes; retry retains scalars, never a view | Node/browser; guest wasm32/64 | **Unsafe/uncertain.** Special pointers were outside generated descriptors | **Implemented; validation pending.** Out-of-range and unrepresentable wasm64 regressions |
| `host/src/kernel-worker.ts::{handleEpollCtl,handleEpollPwait}`; `crates/shared/src/lib.rs::WasmEpollEvent` | Caller process memory for events plus main scratch for the internal poll request; native epoll event is exactly 16 bytes | One `epoll_ctl` event or checked `maxevents * 16`; fields are events at offset 0, zero/ignored pad at 4–7, data at offset 8 | Checked multiplication and complete caller input/output ranges; exact 16-byte records; copy-out explicitly zeroes padding and writes `u64` data at offset 8 | One synchronous attempt; retry/interest state stores values, not process or scratch views | Node/browser; guest wasm32/64 | **Confirmed unsafe caller/output range handling and stale 12-byte assumption** | **Implemented; validation pending.** Exact-end, one-byte-short, padding, and offset-eight regressions |
| `host/src/kernel-worker.ts::{checkedProcessIovecs,kernelIovecFootprint,handleWritev}` | Rust main data allocation; kernel table is 8 bytes per entry and payload follows with four-byte alignment after every entry | Count 1..generated `IOV_MAX` (1,024); full footprint is `8*count + Σ align4(iov_len)` and must be `<= CH_DATA_SIZE` | Native table is 8 bytes/entry on wasm32 or 16 on wasm64; table and every nested source are range-checked losslessly; total is `<= SSIZE_MAX`; result cannot exceed staged payload. Caller linear-memory address zero is valid for a table or data base when the complete positive-length range fits; `{ base: 0, len: 0 }` performs no data access. Positioned offsets remain exact signed `bigint` values across slow chunks | Fast path one lease; slow path sends one checked chunk of at most `CH_DATA_SIZE-8`; no view survives between calls | Node/browser; guest wasm32/64 | **Confirmed live allocation overflow and adjacent offset defect.** Admission omitted per-entry padding and could write 3,072 bytes past the 65,536-byte data area; slow `pwritev` rounded offsets above `Number.MAX_SAFE_INTEGER` | **Implemented; focused Node validation passed.** Exact footprint, address-zero semantics, and exact `2^53+1` slow-path offsets |
| `host/src/kernel-worker.ts::{checkedProcessIovecs,kernelIovecFootprint,handleReadv}` | Rust main data allocation; same 8-byte kernel table/alignment model | Count 1..1,024; table plus requested data must fit 65,536 for fast path; slow chunks reserve the eight-byte table first | Complete native table and every output buffer are checked; returned count must be safe and no larger than offered total; each copy-back uses checked destination capacity. Address zero is caller-owned process memory here, so bounded positive output and zero-length entries may begin there. Positioned offsets remain exact signed `bigint` values across slow chunks | Fast path one lease; slow path one bounded iovec chunk per lease; copy-back bytes are detached | Node/browser; guest wasm32/64 | **Confirmed live allocation overflow and adjacent offset defect.** Fast path subtracted only eight bytes and did not enforce `IOV_MAX`, reaching 8,184 bytes past the data allocation; slow `preadv` rounded offsets above `Number.MAX_SAFE_INTEGER` | **Implemented; focused Node validation passed.** Full-table/count/address-zero and exact `2^53+1` slow-path offset regressions |
| `host/src/kernel-worker.ts::{handleLargeWrite,handleLargeRead}` | Rust main data allocation; one data chunk at most 65,536 bytes | Requested scalar count may be larger, but each scratch transfer is `min(remaining, CH_DATA_SIZE)` | Complete caller source/destination range is proved before the first Rust call; each Rust count is safe and bounded by the offered chunk | One lease per chunk; no view survives | Node/browser; guest/kernel wasm32/64 | Scratch capacity fit; complete caller range was unsafe | **Implemented; validation pending.** Large-I/O source/destination regressions |
| `host/src/kernel-worker.ts::{_handleSyscallInner,handleLargeWrite,handleLargeRead,handleSharedMappingsAfterFileSyscall}` ordinary and large `pread`/`pwrite` | Main scratch for transfer; the positioned file offset is a signed i64 scalar and shared-mapping state has a separate host owner | Ordinary request at most 65,536 bytes; larger requests use checked chunks | The raw channel offset remains `bigint` through ordinary dispatch, large-operation preflight, chunk addition, and kernel argument encoding. Shared-mapping updates use the exact offset only when it is safely indexable; otherwise they refresh from the authoritative file instead of aliasing a rounded JS number | One lease per dispatch/chunk; mapping refresh owns no scratch view | Node/browser; guest wasm32/64 | **Confirmed precision defect adjacent to scratch dispatch.** Ordinary and large `pread`/`pwrite` rounded `2^53+1`, and a rounded shared-map offset could update the wrong page | **Implemented; focused Node validation passed.** Ordinary/large wasm32/wasm64 exact-i64 tests plus shared-map non-aliasing |
| `host/src/kernel-worker.ts::{checkedProcessMessage,kernelMessageLayout,handleSendmsg}` | Rust main data allocation; 28-byte kernel header, optional name/control, 8-byte-per-entry kernel table, and aligned payload share 65,536 bytes | Native msghdr is 28 bytes on wasm32 or 56 on wasm64; iovec count 0..1,024; computed complete kernel footprint must fit | Full native header, optional name/control, native iovec table, and every nested input range are checked losslessly; returned count cannot exceed staged data. An iovec table or bounded data range at caller address zero is intentionally valid; zero-length entries copy no bytes | One synchronous lease; host-owned parsed metadata survives no scratch reuse | Node/browser; guest wasm32/64 | **Confirmed live allocation overflow.** Table construction lacked complete `iovCnt` and allocation-capacity admission | **Implemented; focused Node validation passed.** `IOV_MAX+1`, allocation-sized table, address-zero, and wasm64 pointer/layout regressions |
| `host/src/kernel-worker.ts::{checkedProcessMessage,kernelMessageLayout,handleRecvmsg}` | Same main allocation/layout; caller name, control, and iovec buffers retain their own explicit capacities | Native msghdr 28/56; iovec count 0..1,024; complete 65,536-byte kernel footprint bound | Same complete input/range proof, including caller-address-zero table/data ranges; result count is safe; name/control copy-back uses `min(caller_capacity, returned_length)`; `MSG_TRUNC` may report full datagram length while copying only the bounded prefix; wasm64 flags use offset 48 | One synchronous lease; every process write is a detached bounded copy | Node/browser; guest wasm32/64 | **Confirmed live allocation overwrite risk.** Iovec table/count and aggregate capacity were not proven | **Implemented; focused Node validation passed.** Count/table, address-zero, wasm64 padding/flags, and `MSG_TRUNC` regressions |
| `host/src/kernel-worker.ts::{handleSpawn,decodeSpawnBlobStrings,handleSpawnAfterResolve,beginLargeSpawnScratch,cancelLargeSpawnScratch}`; `crates/kernel/src/spawn.rs::{SpawnScratchBuffer,measure_strings_by_offset,decode_measured_strings}`; `crates/kernel/src/wasm_api.rs::kernel_spawn_reserved_process` | Ordinary blob uses main allocation; large blob uses token-bound Rust `Vec<u8>` whose pointer and actual capacity are returned only while reserved | Complete blob at most generated 8,417,320; argv/environment representation at most 4 MiB; path/action/count caps from generated contracts | Caller ranges, parsed counts, paths, complete blob length, allocation capacity, current memory, pointer width, token, and reservation state are independent checks. Host and Rust first measure every referenced string against one aggregate budget, then allocate/decode | Async lookup owns a JS copy; begin/copy/commit have no await. Begin and pointer/capacity queries fail without waiting on contention. After every successful begin, cancellation runs in `finally`, including setup/copy failure. Commit and cancellation wait on the same no-host-import mutex and return only after the token is consumed, released, or shown stale; host/Rust guards reject overlap. Duplicate maximum-count offsets cannot amplify allocations before rejection | Node/browser; guest/kernel wasm32/64 | #1094 spawn fix was capacity-safe but retained a fixed 8,417,320-byte region after first large use; decoding still admitted allocation amplification from duplicate offsets | **Implemented; focused rehearsal validation and measurement passed.** Growable Rust-owned tokenized reservation, pre-allocation aggregate accounting, exact-count and exact-`ARG_MAX` boundaries, and real Node/Chromium workload; exact final-base rerun remains required |
| `host/src/kernel-worker.ts::{populateMmapFromFile,pwriteFromProcessMemory,readSysvShmRange,writeSysvShmRange}` | Main data allocation for transit, 65,536 bytes per chunk; mapped/shared bytes have separate owners | One `CH_DATA_SIZE` chunk; overall mapping/segment size comes from checked mapping/kernel state | Complete process/mapping range and each Rust producer/consumer count; transit lease separately proves scratch capacity/current memory | One synchronous lease per chunk; authoritative shared bytes/snapshots live outside scratch | Node/browser; guest/kernel wasm32/64 | Capacity fit, bare pointer contract | **Implemented; validation pending** |
| `host/src/kernel-worker.ts::{handleIpcShmat,handleIpcShmdt}` | Process `Memory` mapping and host `SysvShmMapping.snapshot`, not kernel scratch; address key is the checked native guest pointer | Segment size returned by the kernel attachment operation; full mapped range must fit process memory | Raw bigint address is checked losslessly for guest width before attachment/map lookup; mmap result and full mapped range are checked; failure rolls back attachment; shmdt uses the exact checked key | Coherence/attach/detach steps are synchronous; snapshot owns bytes between boundaries; no kernel scratch view is retained | Node/browser; guest wasm32/64 | **Confirmed high-address alias defect.** `>>> 0` narrowed wasm64 hints/detach keys so an address above 4 GiB could alias a low mapping | **Implemented; validation pending.** High hint, unsafe integer, and non-aliasing detach regressions |
| `host/src/kernel-worker.ts::handleSysvMessage`; `crates/kernel/src/ipc_wire.rs` System V message header conversion | Main data allocation; fixed kernel wire header plus payload; caller message begins with native `long` (4 wasm32, 8 wasm64) | Payload is syscall `msgsz`; header plus payload must fit 65,536 for one operation | Exact native mtype field and payload range; checked addition; width passed explicitly; Rust sees fixed wire format only | One synchronous lease; blocking retry retains owned parameters, not a scratch view | Node/browser; guest wasm32/64 | **Unsafe mixed-width/native-long and aggregate-capacity contract** | **Implemented; validation pending.** Exact capacity/capacity+1 and wasm32/64 mtype coverage |
| `host/src/kernel-worker.ts::handleIpcControl`; `crates/kernel/src/wasm_api.rs::{kernel_msqid_ds_bytes,kernel_shmid_ds_bytes}`; `crates/kernel/src/ipc_wire.rs::{read_*,write_*}` | Main data allocation; `msqid_ds` 96/120 and `shmid_ds` 88/112 for wasm32/64 | Exact layout size returned by required Rust query for `IPC_SET`/`IPC_STAT`; pointerless commands stage zero bytes | Width query, command direction, full caller range, allocation capacity, exact Rust slice, and narrowing checks; no fixed fallback | One synchronous lease; outputs serialize completely before copy-back | Node/browser; guest wasm32/64 independent of kernel width | **Confirmed unsafe mixed-width contract.** Fixed wasm32 descriptors proved/staged the wrong LP64 ranges | **Implemented; validation pending.** Exact/short/null/unsupported-width tests |
| `host/src/kernel-worker.ts::handleSemctl`; `crates/kernel/src/wasm_api.rs::{kernel_semid_ds_bytes,kernel_semctl_array_bytes}`; `crates/kernel/src/ipc_wire.rs::write_semid_ds` | Main data allocation; `semid_ds` 72/88 or exact `2 * sem_nsems` array bytes | Rust permission-aware query is authoritative for GETALL/SETALL; structure query is authoritative for IPC commands | PID/TID, command kind, guest width, exact length, caller range, allocation capacity, and Rust slice bounds; missing/invalid required query fails closed | One synchronous lease; no `IPC_STAT` compatibility call is used to infer writable array capacity | Node/browser; guest wasm32/64 | **Confirmed unsafe.** Host assumed 1,024 array bytes and wasm32-only 72-byte structure | **Implemented; validation pending.** Exact/capacity+1, permissions, and missing-export regressions |
| `host/src/kernel-worker.ts::requireTcpScratchRegion` users: TCP, virtual network, UDP, browser-pipe bridges | Separate Rust allocation; private `tcpScratchRegion`, 65,536 bytes | One chunk at most 65,536; oversized UDP datagrams are rejected | Source/backend length, region capacity/current memory, and Rust producer count | Each callback/worker message enters one synchronous lease and detaches output before returning | Node/browser; kernel wasm32/64 | Sizes fit, but pointer escaped ownership value | **Implemented; validation pending.** Private capacity-bearing region |
| `host/src/kernel.ts` public socket/poll/terminal/ioctl/uname/pipe/rusage/select methods | Separate Rust allocation; private `apiScratchRegion`, 65,536 bytes | Call-specific exact fixed record or bounded payload | Lease proves allocation and current memory; call validates caller/result length | One synchronous public call; nested use fails | Node/browser; kernel wasm32/64 | **Confirmed unsafe ownership.** Temporary addresses 4 and 16 named no Rust allocation | **Implemented; validation pending.** Allocator-owned public scratch |
| `host/src/kernel.ts::{hostRead,readKernelBytes,writeKernelBytes}` and VFS (`stat`, `statfs`, `pathconf`, `readlink`, `readdir`), clock, random, waitpid, network/getaddrinfo, GL, proc, and KMS import callers | Rust-owned slice/local/struct lent as pointer plus explicit capacity for one import; `host_kms_mode_info` instead derives its exact 68-byte capacity from generated `WpkDrmModeModeinfo`; producer backends receive host-owned staging buffers rather than a live kernel view | Genuine intrinsic backend span no larger than the Rust-supplied or generated capacity; fixed formats use their exact generated/Rust size | Raw signed wasm32 or bigint wasm64 import pointer is normalized losslessly; nonnegative safe length, complete current-memory range, detached/staged producer data, and producer count precede one `writeKernelBytes` publish; no typed-array clamping or subclass getter counts as validation | Synchronous import only; neither backend nor callback receives a kernel-memory view | Node/browser; kernel wasm32/64 | Correct owner but incomplete conversions/result checks and live-view lending | **Implemented; validation pending.** Checked Rust-lent range plus host staging; high-bit wasm32 KMS and hostile-producer regressions; raw sink is explicitly allowlisted below |
| `apps/browser-demos/test/fixtures/opfs-advisory-lock-client-worker.ts::issue`; `apps/browser-demos/test/epoll-repro.ts::main` | Test kernel allocations represented as `KernelScratchRegion`; one complete channel | Fixed diagnostic channel and event records | Same lease capacity/current-memory rules as production | One lease covers stage/dispatch/snapshot | OPFS: real Chromium wasm32; epoll diagnostic: Node wasm32 | Sizes fit, bare diagnostic pointers/views | **Implemented; current targeted Chromium validation blocked.** An earlier pre-final OPFS run passed, and the static contract includes both selected diagnostic sources. The current targeted Chromium run stops before assertions because the program graph rejects an ABI-42 `bzip2.wasm`; it is not counted as current browser evidence |
| `host/src/{node,browser}-kernel-worker-entry.ts` clone/transport; process-worker argv/environment | Process `Memory`, `ArrayBuffer`, or `SharedArrayBuffer`, not kernel scratch | Process layout/worker-protocol limits | Process-owner and transport-specific validation | Worker/process lifetime, not a scratch lease | Node/browser; guest wasm32/64 | Outside allocator model | **Reviewed exclusion; final transport tests pending** |
| `host/src/framebuffer/**`; `host/src/dri/**`; GL command buffers; mmap/SysV backing views | Framebuffer/process memory or explicit host shared backing, never a pointer returned by `kernel_alloc_scratch` | Mapping/device-specific dimensions and buffer sizes | Subsystem owner/range contracts; static ownership seeds prevent reclassification as kernel scratch | Device/mapping lifetime; may be asynchronous by design, so no allocator-scratch view may enter these objects | Node/browser; guest wasm32/64 | Outside allocator model | **Reviewed exclusion, not declared globally safe.** Static contract covers ownership boundaries; subsystem-specific runtime validation remains required |

## Explicit write sinks and raw-write allowlist

All allocator-owned bulk transfers and scalar channel writes converge on the
following sinks. `KernelScratchDataView` is a guarded part of the abstraction,
not an allowance for a caller-created native `DataView`; the three remaining
rows are the exact raw-write allowances admitted by the compiler-backed
contract. All variable-size allocator-owned syscall staging must call
`KernelScratchLease`. The other allowlisted occurrences in
`host/test/kernel-scratch-contract.test.ts` are read-only views, revocable
checked views, allocator/reservation control calls, or atomic futex control;
none authorizes another raw variable-size write.

| Exact write sink | Destination owner and capacity proof | Source/result proof | Lifetime / disposition |
|---|---|---|---|
| `host/src/kernel-scratch.ts::KernelScratchDataView::{setBigInt64,setBigUint64,setFloat32,setFloat64,setInt8,setInt16,setInt32,setUint8,setUint16,setUint32}` | The native `DataView` is private and spans only the range proved by `KernelScratchLease.dataView`; a `Memory.buffer` replacement triggers the full proof again | Native `DataView` bounds-checks each scalar width and offset inside that exact range | Every setter calls `currentView`, which rechecks the active lease; **guarded scratch-core sink, not a raw allowance** |
| `host/src/kernel-scratch.ts::KernelScratchLease.copyFrom` — `Uint8Array(...).set(...)` | `ownedRange` proves the private region pointer, explicit allocation capacity, pointer width, and current `Memory.buffer` range | Source offset/length are safe integers and fit the source's intrinsic typed-array slots; the exact native base-class view prevents a subclass override from widening the write | Synchronous active lease only; **scratch-core allowance** |
| `host/src/kernel-scratch.ts::KernelScratchLease.fill` — `Uint8Array(...).fill(...)` | `ownedRange` supplies exact checked start/end inside the allocation and current memory | Fill length/value validation occurs before construction | Synchronous active lease only; **scratch-core allowance** |
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
| `ptyMasterWrite` — “chunks PTY input at the exact scratch capacity and capacity + 1” | The old single `.set(data, scratchOffset)` accepts more than the 65,608-byte allocation because only total linear memory constrains the typed-array write | 65,608 is one call; 65,609 becomes calls of 65,608 and 1; 16 KiB sentinel after the allocation is unchanged |
| `setCwd` — “rejects an oversized initial cwd before copying it” | `CH_TOTAL_SIZE + 1` encoded bytes are copied first; only the later Rust call applies `PATH_MAX` | Host rejects before `kernel_set_cwd` and before scratch mutation |
| `handleWritev` — “accounts for every writev table and alignment byte” | 1,024 iovecs contain 57,344 payload bytes, so the old `57,344 + 8,192 == 65,536` admission passes. Per-entry four-byte alignment makes the real footprint 68,608, writing 3,072 bytes beyond the data allocation | Complete `8 * count + Σ align4(len)` footprint is rejected or chunked; tail sentinel stays intact |
| `handleReadv` — “subtracts the complete readv iovec table from data capacity” | 1,024 entries request 65,528 data bytes. The old fast limit subtracts only one eight-byte entry, while the actual table is 8,192 bytes; the footprint is 73,720, or 8,184 bytes beyond the 65,536-byte data allocation | Complete table is included, `IOV_MAX` is enforced, returned bytes are bounded, sentinel is unchanged |
| `handleSendmsg` / `handleRecvmsg` — `IOV_MAX + 1` cases | The old path calls Rust instead of rejecting count 1,025 with `EINVAL` | Count 1,025 is rejected before scratch mutation or Rust dispatch |
| `handleSendmsg` / `handleRecvmsg` — allocation-sized table cases | Count 8,192 alone consumes 65,536 kernel-table bytes, but the old path also writes the 28-byte kernel message header and aligned optional/data sections | Complete header/name/control/table/data layout must fit 65,536; sentinel is unchanged |
| Vector/message wasm64 nested pointers | `Number(bigint)` loses an unrepresentable iovec/base/header pointer and permits an aliased range to reach Rust | Raw bigint remains intact through guest-width and safe-integer checks; failure precedes mutation |
| Slow `preadv` / `pwritev` positioned offset | Reassembling the signed high and unsigned low words as a JavaScript `Number` rounds `2^53 + 1` down to `2^53`, so the chunked path re-emits the wrong low word | Offset assembly, per-chunk addition, write-budget preflight, and low/high re-emission remain `bigint`; wasm64 ingress normalizes the complete low slot before any Number conversion |
| Ordinary and large `pread` / `pwrite` positioned offset | The generic ordinary path converted the signed i64 channel slot to `Number`, and the large path reused that rounded value across preflight and chunks. Shared-mapping follow-up could then index the rounded page | Both caller widths preserve `2^53+1` on the ordinary path and increment it exactly across a 65,536-byte chunk; an offset that cannot be indexed losslessly triggers authoritative mapping refresh instead of an aliased update |
| `Getaddrinfo` generic descriptor — “copies only getaddrinfo's four-byte result before the caller canary” | The old fixed 256-byte output descriptor copies 252 bytes beyond musl's four-byte result object | Detached copy-back is exactly four bytes and preserves a 252-byte canary |
| `handleGetgroups` and `kernel_getgroups` | The old generic call passes the caller's process pointer as if it were a kernel pointer; Rust writes one `u32` without receiving the owned destination capacity | Size zero lends pointer/capacity zero; positive size lends exactly four bytes; Rust rejects capacity 0/3 and accepts 4/5; detached gid copy precedes reuse |
| `Setgroups` generated descriptor | The old raw pointer crosses address spaces. The current Rust implementation does not dereference it, so this is an unsafe contract rather than a claimed observed overwrite | Exactly 16,384 gids fit; 16,385 is rejected; count zero ignores even an unrepresentable pointer; positive null returns `EFAULT` |
| Request-aware `ioctl` — FIONREAD canary and exact capacities | The old generic 256-byte argument copies back 252 bytes beyond a four-byte FIONREAD object; it also cannot distinguish scalar/no-argument requests from pointer requests | FIONREAD copies exactly 4; wasm32 TIOCGPTN is 4, wasm32 DRM VERSION is 36, wasm64 DRM VERSION is 64; one-byte-short/null fail before mutation; scalar/no-arg/unknown stage no pointer |
| Width-incompatible `ioctl` requests | The old contract has no lossless distinction for pointer-bearing wasm32-only layouts such as `GLIO_QUERY` and wasm32 DRM VERSION | wasm64 rejects those known requests with `EOVERFLOW` before conversion or copy |
| Caller-native process records | Fixed wasm32/partial descriptors under-copy or copy back the wrong layout for wasm64; `sigevent` was treated as 16 rather than 64 bytes; `sysinfo` used stale syscall 208 instead of musl 269 | `tests/abi/{process-native-layouts,fixed-process-layouts}.c`, Rust exact/short tests, and host `sysinfo` exact-end/one-byte-short tests cover the enumerated 12/24, 16/32, 32/64, 64, 88/120, 312/368, 128, 112, and 48-byte records |
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
  size-and-offset drift checks for signal-stack, interval-timer,
  message-queue, filesystem-statistics, and system-information records.
- `tests/abi/fixed-process-layouts.c`,
  `scripts/check-fixed-process-layouts.sh`,
  `tests/abi/sysv-ipc-layouts.c`, and
  `scripts/check-sysv-ipc-layouts.sh`: fixed-record and System V
  structure-size/offset checks for both caller widths.
- `crates/kernel/src/process_wire.rs` and
  `host/test/process-native-layout.test.ts`: exact-size and capacity+1 parsing
  and serialization tests, zeroed padding/reserved bytes, and end-to-end
  wasm32/wasm64 syscall round trips. Focused host boundary tests separately
  prove `sysinfo` exact-end admission and one-byte-short rejection. The two
  runtime cases are self-contained and now set `useDefaultRootfs: false`;
  both passed against the rebuilt ABI-43 kernel and host artifacts.
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
  guard plus focused ownership-propagation, write-kind, escape, and
  exact-allowlist fixtures.
- `host/test/kernel-scratch-transfer-boundaries.test.ts` plus
  `crates/kernel/tests/wasm_api_channel_pointer_contract.rs`: a zero-length
  `sendmsg` iovec is transported as `{ base: 0, len: 0 }`, while the Rust
  consumer must select a valid empty slice before any `from_raw_parts` call.

## Open evidence gaps

These gaps prevent a “safe” or “ready” disposition even where the current
source contains the intended checks:

1. The integrated rehearsal checks and final rebuilt-artifact runs passed for
   the current source, but the benchmark metadata still describes an
   uncommitted rehearsal worktree rather than a frozen final commit. An
   exact-committed-head rerun remains required, followed by another complete
   rerun after retargeting. Test presence or an earlier source fingerprint is
   not substituted for either run.
2. Framebuffer, Direct Rendering Manager (DRM), OpenGL, shared-mapping, and
   process-worker transfers are deliberately excluded from allocator scratch.
   The static ownership audit can prove that no kernel scratch view escapes
   into those objects; it cannot by itself prove every subsystem's mapping
   dimensions, callback lifetime, or browser behavior.
3. The dedicated self-contained `spawn-scratch` suite has run on both Node and
   real Chromium with current host-source fingerprints. That evidence is
   limited to spawn transport. The targeted Chromium runtime specs stop at
   Vite startup because the program graph rejects stale ABI-42 `bzip2.wasm`;
   no assertion runs. Earlier OPFS advisory-lock evidence predates the current
   artifacts and is not upgraded to a current-tree pass.
   This does not establish every device/shared-memory exclusion or wasm64
   browser path. The complete browser suite remains blocked by unavailable
   ABI-43 application-package artifacts, and those unexecuted paths must not
   be described as browser-validated.
4. The complete Sortix surface cannot start through its normal runner while
   the eagerly resolved optional program graph contains stale ABI-42 `curl`,
   `wget`, `gzip`, `bzip2`, `xz`, `zstd`, `zip`, `unzip`, and `nano`
   artifacts. Git, Less, and Tar were rebuilt normally, exposing the next
   rejected artifact each time; no resolver bypass or test-only exception was
   added. Focused process-layout, System V IPC, timer/signalfd, terminal, and
   host process/spawn fixtures do not substitute for Sortix. The libc and Open
   POSIX runners were not run, so their status is not inferred from the
   independently observed Sortix block.
5. Comparable focused measurements now establish reported retained scratch
   capacity and post-run/peak kernel linear memory for the deterministic
   workload. The timing sample and baseline-harness provenance are insufficient
   for a speed or broad no-regression claim. The performance guide's complete
   application suites remain blocked by unavailable ABI-43 PHP, WordPress, and
   MariaDB artifacts.
6. The declared development shell does not provide its pinned
   `rustfmt`/`cargo-fmt`; the only discovered formatter is an undeclared
   Homebrew binary that produces unrelated repository-wide churn. Rust
   formatting validation is blocked until the declared toolchain supplies the
   formatter.
7. PR #1097 has not merged. Every result in this rehearsal must be retargeted
   and rerun against its actual merge commit before an exact final head can be
   presented to Brandon for approval.

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

## Spawn buffer sizing evidence

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

The tokenized Rust-owned reusable region is the chosen rehearsal
implementation because Rust remains the sole allocation owner and no pointer
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
completion and did not change kernel allocation or copy behavior. Current
measurements used the tokenized ABI-43 kernel and host artifacts in this
worktree.

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
The exact-#1094 and current hardened workload Wasm files have SHA-256 values
`b207969191ac8132150d43a84f0f2857db4326e7108b93ff60be7159de835514`
and
`e0738d4e6f87e099aa843ae562b03f14b1e16dd30b92abed2302a429c8119cfc`.
The exact baseline kernel Git tree is
`6a8721697edbfa5f4fbd22cb21b41d8ccdcc4a2e` and its built kernel SHA-256 is
`e6979f1fa7fdec68959c7f735c3c16ea91060c61cd203e86fd02eaf9a00326bd`;
the current built kernel SHA-256 is
`db2835a4905023c81a3eecaa6861feb955ea0610eb34763a8de65983b8a96ddb`.
The current Node worker bundle is
`f3e1ae982b9c85fffa8caf85907e9c73e52db1cd24e7a9a2da2a132af279dfdb`,
and the current `host/src` fingerprint is
`89c24dba492309f0196059184e9af0ffaca4e91f1faa139ed0caa0be6574ac21`.
The fixed-baseline Node and Chromium raw logs have SHA-256 values
`f4374b0df0a66bbbd56f19c5637542fa8f40bbfe5f552b23af055c43fcb18dcc`
and
`a0a4b52088ab19ad71bc88ee48c514e1bc5b0c5c58f33410c66a2bcf5d44e814`.
The final-rebuild rehearsal result files are
`benchmark-node-1785010575047.json` with SHA-256
`78ccaac5f4b737b34b934f68ae808769512c3da824414452dd06d6a325b42fc8`
and `benchmark-browser-1785010588397.json` with SHA-256
`bbef0b4bb0f82edc3d7f4fcfbc07d8e4fcc88ded464f989a99d2888e96794ede`.
Those result files fingerprint the exact runtime inputs above, but their Git
metadata records older committed head
`08620d9233a2812eb1098fe6e7b53a7fba58afb4` while the measured implementation
was still uncommitted. They are not a substitute for the exact committed-head
and post-retarget reruns.

The baseline archive was exact #1094 plus a host-only telemetry diff, with
SHA-256
`f78fbd452f1b758aa9494998e00816aae521d1fc4d66e5c2a0d7de8062ebe73e`;
that diff reported the already-retained fixed capacity and did not change the
kernel allocator or copy path. Its Node worker bundle was
`dd9e9e03c84d80df116448594727f2e12af2957bac3b1e55b3fa9c7b27df5e35`.
The older Chromium wrapper labels the combined run `process-lifecycle`, while
the current wrapper labels the isolated component `spawn-scratch`; both
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
after #1097 merges and the branch is retargeted.

## ABI decision

`ABI_VERSION` is 43 in the rehearsal implementation:

- Generated spawn wire values and accepted limits remain byte-for-byte
  identical. Moving those constants to the existing generation path would not
  require a bump by itself.
- The large-spawn host/kernel contract is incompatible. The old
  pointer-returning reserve/fixed-fallback model is replaced with required
  begin, pointer, capacity, cancel, and token-consuming commit exports.
- The host-adapter manifest continues to require `kernel_spawn_process` and
  now also requires `kernel_spawn_reserved_process`,
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

The current Rust source, generated TypeScript consumer, and ABI snapshot all
declare ABI 43, and the generated TypeScript includes the request-aware ioctl
table. Generated-file freshness and the classifier still require a final-head
run after implementation stabilizes. The ABI epoch must then be re-evaluated
after retargeting to #1097's actual merged result; if that result already
consumes ABI 43, this work must advance to the next epoch rather than hiding an
incompatible contract under an occupied version.

## Validation evidence

All commands used for this ledger ran through `scripts/dev-shell.sh`. The
results describe rebuilt artifacts from the current uncommitted rehearsal
worktree based on exact #1094 head. Artifact fingerprints are recorded above;
these results are not presented as an exact committed-head or final-base run.

Completed rehearsal evidence:

- `bash scripts/dev-shell.sh bash build.sh`: passed the complete declared build,
  including the wasm32 kernel, wasm32/wasm64 guest programs, the TypeScript
  host, and the root filesystem.
- `bash scripts/dev-shell.sh cargo build --release -p kandelo --target
  wasm64-unknown-unknown -Z build-std=core,alloc`: passed an explicit wasm64
  kernel build from the frozen Rust source.
- `bash scripts/dev-shell.sh cargo test --target aarch64-apple-darwin -p kandelo
  --lib`: 1,297 kernel tests passed.
- `bash scripts/dev-shell.sh cargo test --target aarch64-apple-darwin -p kandelo
  --test wasm_api_channel_pointer_contract`: four
  integration tests passed. These are source-contract checks over the Wasm API
  dispatcher and zero-length `sendmsg` guard, not a wasm-target runtime
  execution.
- `bash scripts/dev-shell.sh bash scripts/check-abi-version.sh`: passed the ABI
  classifier and snapshot, generated Rust/TypeScript/C freshness checks, and
  the wasm32/wasm64 native-layout checks.
- The following explicitly enumerated focused host Vitest invocation passed
  531 tests across 28 files:

  ```bash
  bash scripts/dev-shell.sh bash -lc 'cd host && npm test -- --run \
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
    test/spawn-pid-authority.test.ts'
  ```

  It included the scratch region, transfer boundaries,
  public wrapper, spawn transport, compiler-backed write audit, native
  process layouts, System V IPC, timer/signalfd, exact positioned I/O,
  shared-memory non-aliasing, deferred copy-back, worker input snapshot, and
  process/spawn lifecycle cases. Concrete boundary cases cover the exact
  65,608-byte main region; exact and capacity-plus-one checks for the 65,536-byte
  TCP, audio, and public API regions; and ordinary, exact-reservation, and
  reservation-capacity-plus-one spawn paths. This is focused Node evidence; it
  is not a complete host-suite or browser claim.
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

  The temporary fresh projection is build evidence, not an intended source
  change; the committed file was restored byte-for-byte to the exact base.
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

Blocked or not completed:

- From `apps/browser-demos`,
  `../../scripts/dev-shell.sh env CI=1 KANDELO_PLAYWRIGHT_PORT=15466
  npx playwright test test/terminal-attributes-api.spec.ts
  test/wait-lifecycle.spec.ts test/environment-lifecycle.spec.ts
  test/opfs-advisory-lock.spec.ts --project=chromium` stopped during Vite
  startup because the program graph rejected stale ABI-42 `bzip2.wasm`.
  No assertion ran; after the blocked setup was interrupted, one test was
  reported interrupted and five did not run. This is neither a Chromium pass
  nor a changed-runtime failure.
- The normal complete Sortix runner remains blocked before its conformance
  surface by stale optional ABI-42 artifacts: `curl`, `wget`, `gzip`,
  `bzip2`, `xz`, `zstd`, `zip`, `unzip`, and `nano`. No resolver bypass or
  test-only exception was used.
- The libc and Open POSIX runners were not run in this rehearsal. Their status
  must not be inferred from the independently observed Sortix artifact block.
- The performance guide's complete application suites remain blocked by
  unavailable ABI-43 PHP, WordPress, and MariaDB artifacts. The focused timing
  sample is not substituted for those suites.
- `bash scripts/dev-shell.sh cargo fmt --all -- --check` could not start:
  the declared shell reports `error: no such command: fmt`. The discovered
  Homebrew formatter is undeclared and was not used.
- The complete validation set has not run from a frozen committed head, and PR
  #1097 remains unmerged.

All of that evidence must be rerun after #1097 merges and this branch is
retargeted to its actual integrated result. Until then, this rehearsal is not
ready. The focused Chromium and retained-capacity results above are not
final-base or complete-application evidence, and no approval or merge should
be requested from this head.
