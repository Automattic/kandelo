# Pthread control memory multi-memory plan

**Date:** 2026-06-04
**Status:** Future work
**Objective:** Reduce or eliminate statically reserved per-pthread control pages in process linear memory by moving host/kernel communication state into a separate per-process WebAssembly control memory when multi-memory support is broadly available.

## Background

The current compact process-memory layout reserves one fixed pthread slot per possible simultaneous pthread. Each slot is four Wasm pages, or 256 KiB:

```text
slot page 0: TLS/control page
slot page 1: fork-save/scratch page
slot page 2: syscall channel primary page
slot page 3: syscall channel spill page
```

This makes the default pthread capacity expensive. Reserving 64 slots adds 16 MiB to every process's initial memory footprint even if the process creates no pthreads.

WebAssembly multi-memory can split process memory from host/kernel communication memory:

```text
memory 0: process memory
  - guest static data
  - guest stacks
  - guest heap/brk/mmap
  - compiler-managed Wasm TLS data

memory 1: process control memory
  - main syscall channel
  - main fork-save/scratch storage
  - pthread syscall channels
  - pthread channel spill storage
  - pthread fork-save/scratch storage
  - host-owned control metadata
```

The important property is that ordinary C/C++ guest pointers address memory 0. Accidental guest stores through bad process-memory pointers cannot corrupt memory 1. This is stronger than reserving ranges inside one shared linear memory, which only prevents brk/mmap/malloc overlap.

## Browser support gate

Multi-memory is a finished WebAssembly proposal, but it is not yet usable as the only browser ABI for Kandelo.

As of 2026-06-04, MDN browser-compat-data reports `webassembly.multiMemory` support in Chromium-based browsers and Firefox, but not Safari or iOS Safari. A multi-memory ABI therefore needs either:

- a single-memory fallback path for Safari, or
- an explicit product decision to drop Safari/iOS Safari support for that runtime mode.

Track support through:

- https://github.com/mdn/browser-compat-data/blob/main/webassembly/multiMemory.json
- https://github.com/WebAssembly/proposals/blob/main/finished-proposals.md

## Target design

### Two memories per process

Each process gets two shared `WebAssembly.Memory` instances:

- `processMemory`: imported as memory 0 by the guest program and pthread worker instances.
- `controlMemory`: imported as memory 1 by trusted Kandelo glue, or owned by a trusted shim that exposes syscall helpers to the guest.

The kernel worker receives both memories. Guest brk/mmap operate only on `processMemory`. Pthread channel allocation operates only on `controlMemory`.

### Control slots grow on demand

Do not allocate pthread control slots at the end of `controlMemory`. Shared Wasm memories grow upward, so a high-end downward allocator either forces a large initial memory or requires growing to the high address before the slot can be used.

Use an upward control-memory allocator instead:

```text
controlMemory

page 0..N:
  fixed process control header
  main syscall channel
  main fork-save/scratch storage

next pages:
  pthread control slot 0
  pthread control slot 1
  ...
```

On `pthread_create`, the host allocates the next free control slot, grows `controlMemory` if needed, zeros the slot, and passes the thread worker the control-memory offsets for its channel and fork-save storage.

### Slot shape

A future multi-memory slot should separate guest TLS from host communication:

```text
processMemory:
  per-thread Wasm TLS / musl struct pthread backing, if still required by compiler/runtime ABI

controlMemory:
  pthread fork-save/scratch storage
  pthread syscall channel primary area
  pthread syscall channel spill area
```

The current TLS page probably cannot move wholesale to memory 1 without deeper compiler/linker work, because `__wasm_init_tls` and `_Thread_local` access operate through the guest module's normal memory. Treat TLS migration as a separate compiler ABI project.

### Trust boundary

There are two possible trust models:

1. Guest module imports memory 1 directly and syscall glue writes to memory 1.
   - Protects against accidental C/C++ memory corruption in memory 0.
   - Does not protect against malicious or hand-authored Wasm that intentionally stores to memory 1.

2. Guest module does not import memory 1; a trusted shim owns memory 1 and exposes syscall helper functions.
   - Stronger isolation from guest Wasm.
   - Larger ABI/tooling change because current syscall glue writes directly into a channel.

The stronger model is the long-term target. The direct-import model may be an incremental step if the primary goal is reducing accidental control-memory corruption and process-memory footprint.

## Implementation phases

### Phase 1: Capability and ABI selection

Files likely involved:

- `host/src/process-memory.ts`
- `host/src/worker-main.ts`
- `host/src/browser-kernel-worker-entry.ts`
- `host/src/node-kernel-worker-entry.ts`
- `host/src/worker-protocol.ts`
- SDK build metadata / ABI declarations

Tasks:

1. Add host feature detection for multi-memory modules and browser support.
2. Define an ABI marker for multi-memory control-channel binaries.
3. Keep the existing single-memory layout as the compatibility path.
4. Reject multi-memory binaries with a clear diagnostic when the runtime lacks support.

### Phase 2: Control-memory allocator

Files likely involved:

- `host/src/thread-allocator.ts`
- `host/src/process-memory.ts`
- `host/src/kernel-worker.ts`
- `host/src/worker-protocol.ts`

Tasks:

1. Add a per-process `controlMemory`.
2. Allocate main process channel and fork-save storage from `controlMemory`.
3. Allocate pthread channel/fork/spill slots from `controlMemory` on demand.
4. Grow `controlMemory` only when an active slot crosses the current length.
5. Recycle slots on thread exit after channel cleanup is complete.

### Phase 3: Syscall glue migration

Files likely involved:

- `libc/glue/channel_syscall.c`
- `libc/glue/abi_constants.h`
- `host/src/worker-main.ts`
- `host/src/wasi-shim.ts`

Tasks:

1. Teach syscall glue to target memory 1 for channel operations.
2. Keep guest pointer arguments as memory-0 offsets.
3. Update host syscall handlers so channel reads/writes use `controlMemory`, while guest data copies use `processMemory`.
4. Audit every channel data-buffer use to distinguish control-memory transfer buffers from process-memory user pointers.

### Phase 4: Fork and pthread integration

Files likely involved:

- `host/src/kernel-worker.ts`
- `host/src/worker-main.ts`
- `crates/fork-instrument/src/*`
- `docs/fork-instrumentation.md`

Tasks:

1. Move fork-save buffers to `controlMemory`.
2. Update fork instrumentation imports/exports so unwind and rewind use the control-memory fork buffer.
3. Ensure fork children get a fresh control memory with only the child main channel and required fork-replay state.
4. Ensure pthread workers receive both process and control memory handles.

### Phase 5: Strong isolation shim

Files likely involved:

- host import construction in `host/src/worker-main.ts`
- SDK glue generation
- ABI documentation

Tasks:

1. Remove direct memory-1 imports from untrusted guest modules.
2. Put channel writes in a trusted shim or host import layer.
3. Keep the guest ABI in terms of functions, not raw control-memory addresses.
4. Validate that an intentionally bad guest pointer store can corrupt memory 0 but not control memory.

## Validation

- Browser feature-detection tests for Chromium, Firefox, and Safari fallback.
- Node runtime tests for multi-memory process startup.
- Pthread smoke tests with more than the old default slot count.
- Thread slot reuse tests.
- Fork-from-thread tests.
- Tests proving guest `mmap`, `munmap`, `mremap`, and `brk` cannot affect control memory.
- Negative corruption test: a guest writes across process memory near the old channel address and the syscall channel remains intact.
- ABI tests proving old single-memory binaries still run.

## Open questions

- How much of the current TLS/control page can be eliminated or reduced without moving TLS to memory 1?
- Should the first multi-memory ABI directly import memory 1, or wait for a trusted shim design?
- What fallback policy is acceptable while Safari and iOS Safari lack multi-memory support?
- Should control memory have its own configurable maximum independent of process memory maximum?
- Should control-memory channel spill buffers remain per-thread, or move to a shared per-process spill pool?
