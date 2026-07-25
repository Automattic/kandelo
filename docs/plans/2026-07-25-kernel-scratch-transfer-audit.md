# Kernel Scratch Transfer Audit

Status: audit and implementation complete on exact PR #1094 head
`6d923c6454dd7174082f25c3d3991d03f86f5ddb`. PR #1094 was closed without
merging after this work began; its announced replacement will land from
current `main`. This branch is therefore a rehearsal stack only. It must be
retargeted and revalidated against that replacement's actual integrated result
before it can be presented as ready, and it must not be merged from this base.

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
  cannot recover a bare allocation pointer outside an active lease.
- `KernelScratchLease` is the only read/write interface. Every operation
  rechecks non-negative safe-integer offsets and lengths, allocation capacity,
  pointer arithmetic, pointer width, and the current memory buffer.
- `withLease` permits sequential reuse but rejects nested/reentrant use and
  promise escape. A guarded `KernelScratchDataView` is revoked when the lease
  ends and reacquires the current buffer after an in-lease `memory.grow()`.
- `checkedMemoryRange` handles Rust-lent destinations and caller-owned process
  ranges without pretending that they are allocator-owned scratch. Address
  zero is allowed only when the specific caller-memory contract permits it.

`host/test/kernel-scratch-contract.test.ts` is the static contract. It rejects
new bare main/TCP/spawn scratch pointers, raw typed views over kernel memory,
and direct variable-size kernel-memory writes outside the reviewed helpers.
Framebuffer, process-memory, and explicit shared-backing copies remain on a
separate allowlist because their owner is not the kernel scratch allocator.

## Allocation inventory

| Region and symbols | Allocating owner; pointer/capacity | Maximum accepted source | Lifetime and overlap | Hosts / widths | Audited-head disposition | Final disposition |
|---|---|---|---|---|---|---|
| Main syscall scratch, `CentralizedKernelWorker.scratchRegion` | Rust `kernel_alloc_scratch`; `KernelScratchRegion`, 65,608 bytes (`CH_TOTAL_SIZE`) | Each layout is checked against the region; ordinary data payload is at most 65,536 bytes (`CH_DATA_SIZE`) | Kernel lifetime; one synchronous lease per dispatch/copy; nested leases fail | Node and browser; wasm32/64 kernel | **Unsafe contract.** Bare `scratchOffset`; several live overflows | **Safe.** All allocator-owned access is lease-mediated |
| TCP/pipe scratch, `tcpScratchRegion`, `requireTcpScratchRegion` | Rust `kernel_alloc_scratch`; `KernelScratchRegion`, 65,536 bytes | One checked network/pipe chunk, at most 65,536 bytes | Kernel lifetime; worker callbacks/messages detach bytes before yielding | Node/browser; wasm32/64 kernel | **Safe sizes, weak contract.** Private pointer reached other code | **Safe.** Region stays private and all access is synchronously leased |
| Large spawn scratch, `scratchRegionForSpawnBlob` | Rust `SpawnScratchBuffer` `Vec<u8>` through `kernel_spawn_scratch_reserve/capacity`; exact returned pointer/capacity | Complete blob at most 8,417,320 bytes; ordinary blobs use main scratch | Kernel lifetime high-water reservation; reserve may move only before a lease; copy plus parse has no await | Node/browser; wasm32/64 kernel | **Safe after #1094, weak contract.** Fixed 8,417,320-byte allocation retained after first large use | **Safe and sized to demand.** Rust remains owner; compatible old kernels use the reviewed fixed fallback |
| Audio drain, `WasmPosixKernel.audioScratchRegion` | Rust `kernel_alloc_scratch`; 65,536-byte `KernelScratchRegion` | `min(out.byteLength, capacity)` and checked Rust return count | Kernel lifetime; one synchronous drain lease | Node/browser; wasm32/64 kernel | **Uncertain.** Pointer/range and producer count were incomplete | **Safe.** Allocation, requested bytes, current range, and returned count are checked |
| Public wrapper temporary storage, `apiScratchRegion` | Rust `kernel_alloc_scratch`; 65,536-byte `KernelScratchRegion` | Each socket/poll/terminal/ioctl/uname/pipe/rusage/select request must fit | Kernel lifetime; synchronous public-call lease | Node/browser; wasm32/64 kernel | **Unsafe.** Hard-coded addresses 4 and 16 were not allocations | **Safe.** All temporary public API storage is allocator-owned |
| Rust-lent host-import destinations, `checkedMemoryRange`, `writeKernelBytes`, `kernelDestinationView` | Rust slice/local/struct; pointer plus explicit capacity for one import call | Backend result no larger than the Rust-supplied capacity | Only the synchronous import; no view is retained | Node/browser; wasm32/64 kernel | **Valid ownership, incomplete checks.** Lossy conversions and clamping writes existed | **Safe.** Checked pointer conversion, complete range, and producer/result length precede writes |

## Transfer inventory

“Synchronous” below means that no promise, worker-message yield, or callback
boundary can occur while Rust is expected to consume the staged bytes.
Single-threaded event-loop execution is not used as a substitute for capacity
or range validation.

| File / exact symbols | Owner and maximum | Source/range proof | Lifetime / overlap | Applicability | Audited-head disposition | Final disposition |
|---|---|---|---|---|---|---|
| `host/src/kernel-worker.ts::replaceProcessMetadata` | Main region; entry at most `CH_DATA_SIZE`, aggregate exec argv/env at most 4 MiB | Caller bytes are detached; each entry and Rust result are checked | Synchronous push per entry; memory view reacquired after possible growth | Node/browser; wasm32/64 | Safe size, bare pointer | **Safe, migrated** |
| `ptyMasterWrite`, `ptyMasterRead` | Main region; writes chunk at 65,608, reads request at most 4,096 | Host input is chunked; producer result cannot exceed request | Each chunk/producer is one lease; callback receives detached bytes | Node/browser; wasm32/64 | **Unsafe write**, unchecked read result | **Safe; exact-capacity and capacity+1 regression** |
| `setCwd` | Main region; UTF-8 CWD below generated `POSIX_PATH_MAX_BYTES` | Length rejected before allocation access or Rust call | One synchronous lease | Node/browser; wasm32/64 | **Unsafe.** Kernel rejected only after copy | **Safe; pre-copy `PATH_MAX` check** |
| `enumProcesses`, `readProcessMaps`, `kernel_get_cwd`, `kernel_get_fd_path`, wait/wake/mqueue helpers | Main region; fixed or explicitly requested outputs up to 4,096/1,280 bytes | Request and Rust-produced count checked before copy-out | Synchronous producer, detached JS result before callbacks | Node/browser; wasm32/64 | Fixed sizes fit, several counts trusted | **Safe, migrated through `captureMainScratchOutput` or direct leases** |
| `_handleSyscallInner` generic descriptor planning/dispatch | Main region; descriptors generated from shared ABI metadata and complete layout at most `CH_DATA_SIZE` | Raw pointer/length values must be safe integers; caller ranges are validated before staging | Planning stores host-owned bytes only; the dispatch lease stages input, calls Rust, snapshots output, then releases | Node/browser; process and kernel wasm32/64 | **Unsafe domain/reentrancy edges** | **Safe; negative/fractional/overflow and nested-reuse regressions** |
| `handleFcntlLock` | Main data region; fixed 32-byte flock | Complete caller range | Synchronous | Node/browser; wasm32/64 | Safe fixed transfer | **Safe, migrated** |
| `handleSelect`, `handlePselect6` | Main data region; three 128-byte fd sets plus optional eight-byte mask | Every optional fd set, timeout, outer sigmask descriptor, and inner sigmask range is checked | Each attempt is synchronous; retry state owns copies, never a scratch view | Node/browser; wasm32/64 | **Unsafe caller ranges** | **Safe; focused select/pselect regressions** |
| Generic `ppoll` dispatch and retry scalar conversion | Main channel header; 16-byte caller timespec and optional eight-byte signal mask become scalar kernel arguments | Raw pointers are checked losslessly and complete caller ranges are proved before either read; retry repeats the proof | Values are staged only in the final synchronous dispatch lease; retry retains no scratch view | Node/browser; wasm32/64 | **Unsafe/uncertain.** Special pointers were outside generated descriptors | **Safe; out-of-range and unrepresentable wasm64 regressions** |
| `handleEpollCtl`, `handleEpollPwait` | Main data region; 12-byte event or checked `interests.length * 8` | Input event and `maxevents * 12` output array checked before Rust | Synchronous attempt; retry stores host data | Node/browser; wasm32/64 | **Unsafe caller/output ranges** | **Safe; focused input/output regressions** |
| `handleWritev`, `handleReadv`, `checkedProcessIovecs` | Main data region; at most generated `IOV_MAX` (1,024), table, alignment, and payload must all fit | Complete caller iovec table and every nested buffer checked losslessly for wasm32/64 | Fast path is one lease; slow path detaches validated layout and consumes/copies one checked chunk at a time | Node/browser; wasm32/64 | **Unsafe.** writev omitted alignment; readv omitted most table bytes and `IOV_MAX`; slow paths had incomplete ranges | **Safe.** Complete layout admission and adjacent slow-path regressions |
| `handleLargeWrite`, `handleLargeRead` | Main data region; chunks at most `CH_DATA_SIZE` | Complete process source/destination range is proved before first Rust call | One synchronous lease per chunk; no scratch view survives | Node/browser; wasm32/64 | Capacity-safe, caller-range unsafe | **Safe; focused large-I/O regressions** |
| `handleSendmsg`, `handleRecvmsg` | Main data region; message header, name, control, at most `IOV_MAX` iovecs, alignment, and data share one checked layout | Complete msghdr, iovec table, and nested ranges; lossless pointer conversion | One synchronous lease; copy-back is from detached results | Node/browser; wasm32/64 | **Unsafe.** No complete count/capacity proof | **Safe.** `MSG_TRUNC` preserves the full datagram return length while copy-back remains bounded |
| `handleSpawn`, `handleSpawnAfterResolve`, `scratchRegionForSpawnBlob` | Main or growable spawn region; whole blob at most generated 8,417,320-byte ceiling | Caller path/blob/pid-out ranges, parsed counts, 4 MiB argv/env, action paths, exact length, allocation capacity, and current memory checked independently | Async resolution owns a JS copy; reserve, copy, parser call, and result snapshot are one synchronous sequence | Node/browser; wasm32/64 | Safe after #1094, fixed bare large pointer | **Safe, migrated; grow may invalidate only an unleased old region** |
| `populateMmapFromFile`, `pwriteFromProcessMemory`; `readSysvShmRange`, `writeSysvShmRange` | Main data region; one `CH_DATA_SIZE` chunk | Mapping/process range and Rust count checked per direction | Synchronous chunk lease; shared authoritative bytes live outside scratch | Node/browser; wasm32/64 | Capacity-safe, bare pointer | **Safe, migrated** |
| `handleSemctl`, `kernel_semctl_array_bytes` | Main data region; 72-byte `IPC_STAT` or exact Rust-owned GETALL/SETALL array bytes | Exact PID/TID and a permission-aware Rust preflight return the array length; an older ABI-42 kernel uses a bounded `IPC_STAT` compatibility query; process range checked before copy | Synchronous lease; the direct query does not consume ambient dispatch authority, while the compatibility query releases its lease and rebinds the one-shot caller before the real command | Node/browser; wasm32/64 | **Unsafe caller ranges; host assumed 1,024 bytes** | **Safe; exact size, identity, compatibility, and range regressions** |
| TCP, virtual-network, UDP, and browser pipe bridges through `requireTcpScratchRegion` | TCP region; one 65,536-byte chunk; oversized UDP datagrams rejected | Backend/source length and Rust output count checked | Each worker callback/message performs a synchronous lease and detaches output | Node/browser; wasm32/64 | Safe sizes, exposed pointer | **Safe, private capacity-bearing owner** |
| `host/src/kernel.ts` public socket/poll/terminal/ioctl/uname/pipe/rusage/select methods | Public API region, 65,536 bytes | Call-specific source/destination length plus region/current-memory checks | One synchronous public call | Node/browser; wasm32/64 | **Unsafe unallocated low addresses** | **Safe, allocator-owned** |
| `host/src/kernel.ts` host imports: `hostRead`, stat/statfs/pathconf/readlink/readdir/clock/getrandom/waitpid/net recv/getaddrinfo, GL/proc/KMS queries | Rust-lent pointer and declared byte length | `checkedMemoryRange` plus exact backend/result count; no clamping typed-array write is treated as validation | Complete synchronous import only | Node/browser; wasm32/64 | Valid owner, incomplete checks | **Safe, checked lent-range helper** |
| `apps/browser-demos/test/fixtures/opfs-advisory-lock-client-worker.ts::issue` | Main region; one complete channel | Test-owned inputs and fixed output fields fit the leased region | One synchronous lease covers staging, Rust dispatch, and result snapshot | Real Chromium; wasm32 kernel | Safe sizes, bare private pointer | **Safe, migrated; focused Chromium regression** |
| `apps/browser-demos/test/epoll-repro.ts::main` diagnostic channel driver | Main region; one complete channel | Fixed channel arguments and event records fit the leased region | One synchronous lease covers the complete diagnostic sequence | Node; wasm32 kernel | Safe sizes, bare private pointer and raw views | **Safe, migrated; static contract covers the diagnostic** |
| `host/src/{node,browser}-kernel-worker-entry.ts` process cloning and worker transport | Process `Memory`, `ArrayBuffer`, or `SharedArrayBuffer`, not kernel scratch | Process layout and transport contracts | Worker/process lifetime | Node/browser; guest wasm32/64 | Outside scratch model | **Reviewed exclusion** |
| Framebuffer, GL command buffers, mmap/SysV shared mappings, and process-worker argv/env reads | Process memory or explicit shared backing, not kernel allocator storage | Subsystem-specific mapping/range checks | Varies by owning subsystem | Node/browser; guest wasm32/64 | Outside scratch model | **Reviewed exclusion; static allowlist prevents accidental conflation** |

## Executable reproductions and regression coverage

The original ownership failures are reproduced by
`host/test/kernel-scratch-transfer-boundaries.test.ts`. Against exact audited
head `6d923c6`, the initial nine cases fail:

| Reproduction | Exact-head evidence |
|---|---|
| PTY capacity and capacity+1 | One call writes beyond the owned allocation |
| Oversized initial cwd | Rust rejects only after the oversized host copy |
| writev table plus alignment | Sentinel bytes after scratch are changed |
| readv complete table accounting | Sentinel bytes after scratch are changed |
| sendmsg / recvmsg `IOV_MAX + 1` | Rust is called instead of returning `EINVAL` |
| sendmsg / recvmsg allocation-sized table | Host constructs a table beyond scratch |
| wasm64 unrepresentable iovec pointer | Lossy `Number(bigint)` conversion reaches Rust |

The final file has 27 cases after expanding parameterized tests. It covers
those failures plus caller address zero, adjacent vector slow paths, large
read/write, select/pselect, `ppoll` special-pointer conversion, epoll, semctl,
generic descriptor invalid lengths, lease-time staging, and Linux-compatible
`MSG_TRUNC`.

Additional focused files cover the complete abstraction:

- `host/test/kernel-scratch-region.test.ts`: exact capacity/capacity+1,
  negative/fractional/unsafe integer inputs, pointer arithmetic, null,
  end-of-memory, allocation failure, invalid allocator range, wasm32/64,
  sequential/nested/async use, escaped views, and `memory.grow()`.
- `host/test/kernel-public-scratch.test.ts`: removal of low-address scratch,
  public capacity, audio counts, and Rust-lent network output bounds.
- `host/test/spawn-blob-transport.test.ts`: ordinary/fixed-fallback/growable
  transport, allocation failure, invalid reservation, replacement and reuse,
  exact whole-blob ceiling, and wasm64 pointer/capacity.
- `crates/kernel/src/spawn.rs` unit tests: malformed maximum counts, exact and
  oversized argv/environment representation, action-path `PATH_MAX`, complete
  wire ceiling, allocation failure, growth, and reuse.
- `host/test/kernel-scratch-contract.test.ts`: source-level drift guard for
  future direct variable-size writes.

## Platform and spawn contract sources of truth

`crates/shared/src/lib.rs::platform_limits` is authoritative for Kandelo's
advertised `ARG_MAX`, `PATH_MAX`, and `IOV_MAX`. The ABI generator writes those
values to TypeScript and a musl header; the public `limits.h`, musl's compiled
`sysconf`, the TypeScript host, and Rust consume those generated or shared
values. `crates/shared/src/lib.rs::spawn_contract` separately owns the wire
layout and defensive parser count caps. Its generated private C header aliases
the generated platform limits instead of repeating their numbers.

| Value | Meaning | Classification |
|---|---|---|
| 4,194,304 | Combined argv/environment bytes, including representation overhead | Advertised `ARG_MAX` platform limit |
| 4,096 | Path bytes including terminating NUL | Advertised `PATH_MAX` platform limit |
| 1,024 | Maximum iovec entries | Advertised `IOV_MAX` platform limit |
| 40 | Spawn blob header | Cross-layer wire layout |
| 28 | File-action record | Cross-layer wire layout |
| 4,096 argv, 4,096 env, 1,024 actions | Defensive parser count caps | Implementation limits, not extra POSIX limits |
| 8,417,320 | Derived complete blob ceiling: `ARG_MAX + header + actions * (record + PATH_MAX)` | Transport/parser safety ceiling, not `ARG_MAX` |

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
2. A Rust-owned reusable `Vec<u8>` can reserve the requested high-water mark
   and return pointer plus capacity. `try_reserve_exact` reports failure
   without replacing a live region; the host clears its old region before a
   reserve that may move it and never holds a lease across that call.
3. Repeated/geometric host calls to `kernel_alloc_scratch` have no free
   operation and would permanently leak every older region. That design was
   rejected. The older-kernel fixed fallback caches allocation failure too, so
   even an invalid nonzero allocator result is bounded to one attempted
   worst-case region rather than leaking again on every retry.

The Rust-owned reusable region was selected. Measurements use the same final
kernel allocator and the same 84,386-byte wire payload. For the “before” run,
the host runtime is the exact #1094 source at `6d923c6`; its retained count is
the exact allocation request in that source. Kernel pages are read after the
workload, which is also the peak because Wasm memory cannot shrink.

| Host / design | Ordinary spawn median | First ~84 KiB median | Five repeated large spawns, mean per spawn (median of 3 rounds) | Retained spawn bytes | Peak kernel bytes |
|---|---:|---:|---:|---:|---:|
| Node, fixed exact-head host | 16.925 ms | 14.605 ms | 13.7042 ms | 8,417,320 | 26,017,792 |
| Node, Rust growable | 20.769 ms | 16.186 ms | 14.9634 ms | 84,386 | 17,694,720 |
| Chromium, fixed exact-head host | 13 ms | 11 ms | 10 ms | 8,417,320 | 26,017,792 |
| Chromium, Rust growable | 13 ms | 10 ms | 9.8 ms | 84,386 | 17,694,720 |

The measured workload retains 8,332,934 fewer spawn bytes and reduces the
kernel-memory high-water mark by 127 Wasm pages (8,323,072 bytes). Three rounds
are insufficient for a speed or no-regression claim, and the Node samples are
noisy in the opposite direction from Chromium. The change is justified by the
large measured retention reduction; no latency improvement is claimed.

The retained capacity and page telemetry cross the same dedicated worker
protocol used by Node and browser hosts. The full performance suite was
attempted but could not start because its PHP, WordPress, and MariaDB wasm32
and wasm64 artifacts are not published or cached for ABI 42. The focused
process-lifecycle measurements above ran in both Node and real Chromium.

## ABI decision

`ABI_VERSION` remains 42:

- All generated spawn wire values and accepted limits are byte-for-byte
  identical to the prior protocol constants. The generated public musl
  `ARG_MAX` macro now matches the already-advertised 4 MiB `sysconf` and spawn
  boundary instead of its stale 128 KiB value; this is a compatible expansion,
  not an incompatible guest/kernel contract change. `PATH_MAX` and `IOV_MAX`
  retain their existing values.
- No syscall number, argument, errno, pointer interpretation, required host
  capability, or existing kernel export changed incompatibly.
- `kernel_semctl_array_bytes`, `kernel_spawn_scratch_reserve`, and
  `kernel_spawn_scratch_capacity` are additive exports. The generated
  `abi/snapshot.json` records exactly those three additions.
- The host adapter's required-export manifest is unchanged. A host paired with
  an older ABI-42 kernel uses the already safe fixed spawn allocation fallback
  and obtains semaphore-array size through a bounded, read-only `IPC_STAT`
  compatibility query instead of restoring the unsafe fixed-size copy.
- `KernelScratchRegion` is an internal TypeScript value and does not change an
  exported guest or host-adapter structure.

The ABI classifier and generated-file freshness checks must be rerun after
retargeting to the announced main-first replacement for #1094. Any
incompatible change in that actual integrated result overrides this decision
and requires the normal ABI bump.

## Validation evidence

All commands below ran through `scripts/dev-shell.sh`. These results describe
the current rehearsal stack; they must be repeated after retargeting to the
actual main-first replacement for the closed, unmerged PR #1094.

Node and kernel evidence:

- The final `bash build.sh` completed, including the Rust kernels, guest
  programs, wasm64 artifacts, TypeScript host, and 16,787,687-byte root
  filesystem.
- The complete Rust kernel suite passed 1,256 tests with no failures.
- The final scratch-focused host run passed 106 tests across five files:
  region, transfer-boundary, public wrapper, spawn transport, and static
  source-contract coverage. Host declaration generation/typechecking also
  passed.
- A broader focused Node host run covering all 23 touched runtime test files
  plus the SysV IPC integration test passed 381 tests across 24 files.
- The final repository-wide host run reached 2,311 passing tests, two expected
  failures, and 106 skips. It was not green: 10 tests failed and 13 package
  suites failed during import. No scratch-focused test failed. The test
  failures were two existing lazy-archive fetch-mock argument mismatches, the
  stale committed resolver bundle, package/runtime checks blocked by the
  refreshed index's unavailable Git closure, and two package metadata scans
  that timed out. The import failures came from concurrent package tests
  rebuilding the same native Cargo helpers and colliding while archiving
  `ring`/`zstd`; affected package suites reported zero tests.
- Bun teardown/pthread coverage passed three tests.
- The complete Sortix surface passed 5,037 tests, with 23 expected failures
  and 53 skips; it had no failures or timeouts. The POSIX suite passed 174
  tests with three expected failures and two skips. The libc suite passed 302
  tests with 20 expected failures and one flaky pass; `functional/argv`
  timed out in the aggregate run and passed alone in 1.20 seconds.
- `npx tsx apps/browser-demos/test/epoll-repro.ts` completed both immediate
  and one-second `epoll_pwait` diagnostic calls while holding a checked
  scratch lease.
- The ABI classifier, ABI snapshot, generated TypeScript/C bindings, generated
  platform/spawn headers, and final package-index generation/context checks
  passed.

Real-browser evidence:

- `CI=1 KANDELO_PLAYWRIGHT_PORT=55421 npx playwright test
  --grep-invert '@slow|@trap-signal' --project=chromium` ran against an
  isolated Vite server from this worktree: 51 passed, 26 skipped, and five
  initially failed. One failure exposed the OPFS fixture's bare scratch
  pointer. After migration, the final-head retry
  `CI=1 KANDELO_PLAYWRIGHT_PORT=55431 npx playwright test
  test/opfs-advisory-lock.spec.ts --project=chromium --workers=1` passed alone
  in real Chromium.
- The four remaining aggregate failures stop at missing demo assets or the
  resulting Vite error overlay: `shell.vfs.zst` for the image-owned Homebrew
  shell, `nc.wasm` for the network case, and two Kandelo URL user-interface
  cases blocked by the overlay. They did not reach the changed runtime.
- The growable-spawn process-lifecycle measurement ran in real Chromium as
  shown above.

Not run to completion:

- An additional local Sortix public-limit runtime probe did not reach guest
  execution. After regenerating the source package index, the local Git
  package closure required a source rebuild, and its unrelated OpenSSL build
  rejected the configured API-compatibility level. Generated-file freshness,
  the static musl wiring contract, and the completed wasm32/wasm64 musl builds
  support the limit-source claim instead; no conformance claim relies on this
  blocked attempt.
- `PREPARE_BROWSER_ASSETS=1 scripts/ci-run-test-suite.sh browser` built its
  available browser packages but could not prepare the fetch-only Shell image:
  ABI-42 `shell@0.1.0` is neither published nor cached. Playwright therefore
  did not start in that exhaustive preparation run.
- The full Node/browser performance suite could not start its workloads
  because ABI-42 PHP, WordPress, and MariaDB wasm32/wasm64 artifacts are
  neither published nor cached. No broad speed or no-regression claim is made.
- A targeted `rustfmt --check` attempt could not start because `rustfmt` is
  not exposed by the pinned dev shell. Repository-wide `cargo fmt --check`
  would not be usable as narrower evidence in any event because the exact
  base already has broad formatter drift outside these changes.
