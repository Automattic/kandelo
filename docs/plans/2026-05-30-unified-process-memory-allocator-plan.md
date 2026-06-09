# Unified process memory allocator plan

**Date:** 2026-05-30
**Status:** Implemented in PR #595 with follow-up linker ABI work deferred
**Objective:** Move Kandelo process memory to a single coordinated address-space allocator, with host control memory reserved before the guest heap, so processes start small, grow densely, and avoid brk/mmap/control-region collisions without fixed high address floors.

## Background

PR #595 fixes the immediate browser-host bug where every guest process allocated `maxMemoryPages` up front just to place the syscall channel at the end of memory. The new low-control layout starts shared process memory small and grows it on demand. It is correct, but still has two architectural compromises:

- Host control pages sit above the initial brk heap, so the kernel needs a `brk_limit` to stop brk before it reaches the control arena.
- Normal mmap allocation still starts at `0x04000000`, so the first mmap can grow the process memory to about 64 MiB even when the actual mapping is small.

This plan replaces those compromises with a compact host-computed layout and unified kernel brk/mmap coordination. A future SDK/linker ABI can make the control slab an explicit exported program contract, but this PR can safely ship the same memory shape for current binaries by treating exported `__heap_base` as the first byte available to the host layout and moving guest `brk(0)` to the end of the host control slab.

## Target layout

Implemented layout for current binaries:

```text
Process Shared WebAssembly.Memory

0x00000000
  guest linker-owned region
  - static data
  - globals
  - stack / shadow stack
  - TLS templates and other compiler/runtime reservations

__heap_base
__wpk_control_base = page_align(max(__heap_base, imported_memory_minimum))
  host-owned control slab

  main process slot:
    main fork save buffer
    main syscall channel
    channel spill bytes

  pthread slot 0:
    TLS/control page
    fork save buffer area
    syscall channel
    channel spill page

  pthread slot 1:
    TLS/control page
    fork save buffer area
    syscall channel
    channel spill page

  ...

  pthread slot N-1:
    TLS/control page
    fork save buffer area
    syscall channel
    channel spill page

__wpk_control_end

brk_base = mmap_base = __wpk_control_end
  guest dynamic allocation begins here; brk(0) returns this address

managed address space
  one kernel allocator tracks:
  - the contiguous brk VMA
  - mmap VMAs
  - free gaps
  - reserved regions

maxMemoryPages * 64KiB
  configured process address-space cap
```

Future linker ABI target: reserve the host-control slab before the toolchain's exported `__heap_base` and add explicit exports such as `__wpk_control_base`, `__wpk_control_end`, and thread slot metadata. That would let guest tooling see `__heap_base` as the true guest heap start. The current host-computed layout avoids corrupting existing binaries because it never places host data below the exported `__heap_base`.

All workers for a process still share one `WebAssembly.Memory`. The main worker uses the main process slot. Each pthread worker receives the same memory plus a distinct pthread slot. The host tracks slot ownership per pid; exited pthreads return their slots to that process's free list after zeroing.

## Design decisions

### Host control memory belongs before heap

Host control pages must not be placed below the current `__heap_base` for arbitrary existing binaries because that address range can contain guest static data, stack, shadow stack, TLS templates, or linker-reserved state. This PR therefore reserves host control pages after `__heap_base` and before guest `brk_base`. The future SDK/linker ABI can reserve the slab first, then export `__heap_base` after the slab.

### One kernel allocator owns brk and mmap

The kernel `MemoryManager` should become a process VMA allocator. It should track every guest dynamic range in a single ordered map and enforce all overlap rules in one place.

Region kinds:

- `Reserved`: static/linker range and host control slab. Never returned by brk, mmap, or mremap.
- `Brk`: the process break heap. It remains contiguous because POSIX brk semantics require that.
- `Mmap`: anonymous and file-backed mappings.
- `Free`: reusable address-space gaps.

Syscall behavior:

- `brk(0)` returns the current program break.
- `brk(new)` resizes the `Brk` VMA only if the resulting range is valid and the adjacent growth range is free. If an mmap VMA occupies the next pages, brk fails by returning the old break.
- `mmap(NULL, len, ...)` allocates from the unified free-space map, starting near `__heap_base` instead of a fixed 64 MiB base.
- `mmap(addr, len, MAP_FIXED, ...)` may replace compatible mmap regions, but must never replace `Reserved` or `Brk` ranges unless the intended Linux semantics are explicitly implemented and tested.
- `munmap` returns mmap ranges to the free map and supports partial unmaps.
- `mremap` grows in place only when the adjacent range is free, otherwise moves only when flags allow it.

### malloc policy must be intentional

A unified allocator can coordinate brk and mmap, but brk still cannot grow through an existing mmap region. The lowest-risk long-term direction is to make guest malloc mmap-first or mmap-only, leaving brk as a compatibility shim. That lets the unified allocator place allocations densely from low addresses without reserving a large speculative brk corridor.

Near-term compatibility may keep a small brk heap for existing musl behavior while tests verify that brk failure after mmap fragmentation is handled correctly.

### Thread count is bounded by the control slab

Putting pthread control slots before `__heap_base` requires choosing a maximum simultaneous pthread count per process at link/runtime configuration time. The current slot shape is roughly four Wasm pages per pthread slot, or 256 KiB:

```text
16 slots  -> about 4 MiB
64 slots  -> about 16 MiB
256 slots -> about 64 MiB
```

The initial process memory must cover the control slab, so the default thread cap should be moderate and explicit. Later work can compact the slot ABI if this becomes too expensive.

## Implementation phases

### Phase 1: VMA allocator core

Files likely involved:

- `crates/kernel/src/memory.rs`
- `crates/kernel/src/wasm_api.rs`
- `crates/kernel/src/fork.rs`
- `crates/kernel/src/process.rs`
- `host/src/kernel-worker.ts`

Tasks:

1. Replace `MemoryManager`'s independent brk/mmap bounds with an ordered VMA map.
2. Add explicit reserved-region registration for static/control ranges.
3. Implement brk growth/shrink against the VMA map.
4. Implement mmap placement from the lowest suitable free gap after `__heap_base`.
5. Preserve existing munmap partial-split behavior.
6. Update mremap to use the same free-gap checks.
7. Serialize and restore the VMA map across fork/exec where needed.

Validation:

- Rust unit tests for brk growth into free space.
- Rust unit tests for brk failure when mmap occupies the adjacent range.
- Rust unit tests for mmap reuse of low free gaps.
- Rust unit tests for MAP_FIXED rejecting reserved/control overlap.
- Rust unit tests for mremap in-place growth, move, and reserved-region rejection.

### Phase 2: SDK/linker control slab ABI

Files likely involved:

- SDK linker flags and glue sources.
- `libc/glue/*`
- `host/src/constants.ts`
- `host/src/process-memory.ts`
- package build scripts that inspect or override heap layout.

Tasks:

1. Define exported symbols:
   - `__wpk_control_base`
   - `__wpk_control_end`
   - `__wpk_main_channel_base`
   - `__wpk_thread_slots_base`
   - `__wpk_thread_slot_size`
   - `__wpk_thread_slot_count`
2. Reserve the control slab before `__heap_base`.
3. Move `__heap_base` to `align(__wpk_control_end)`.
4. Update syscall-channel glue to use the exported main channel address.
5. Update pthread startup glue to accept a slot index/address from the host.
6. Keep old binaries running through the PR #595 layout until the new ABI is required.

Validation:

- Wasm parser tests proving exported symbols exist and are ordered correctly.
- Small C program showing malloc starts after the control slab.
- Thread smoke test proving each pthread receives a distinct slot.

### Phase 3: Host integration

Files likely involved:

- `host/src/browser-kernel-worker-entry.ts`
- `host/src/node-kernel-worker-entry.ts`
- `host/src/kernel-worker.ts`
- `host/src/thread-allocator.ts`
- `host/test/centralized-test-helper.ts`

Tasks:

1. Parse the new control-slab exports during spawn/exec.
2. Register reserved static/control ranges with the kernel before `_start`.
3. Create shared memory with `initial` just large enough for the binary import and `__heap_base`.
4. Replace page-growing thread allocator with a fixed per-process slot allocator for new-ABI binaries.
5. Keep the existing PR #595 allocator as a compatibility path for old binaries.
6. Ensure fork children copy only the parent's current memory length and inherit the same VMA/control metadata.
7. Ensure exec replaces memory/layout based on the new binary's exports.

Validation:

- Host unit tests for spawn/exec/fork using new layout metadata.
- Repeated process launch cleanup test with no retained channels or process registrations.
- Pthread slot allocation/reuse test.
- wasm32 and wasm64 memory creation tests.

### Phase 4: malloc policy

Files likely involved:

- musl overlay files under `libc/musl-overlay`.
- SDK build flags or libc glue.
- package rebuild rules.

Tasks:

1. Audit musl malloc behavior when brk growth fails early.
2. Decide whether to patch malloc to prefer mmap for normal heap growth.
3. If patched, make brk a small compatibility region rather than the primary heap source.
4. Rebuild representative packages and measure process startup/high-water memory.

Validation:

- libc malloc smoke tests.
- mmap-heavy and malloc-heavy program tests.
- SpiderMonkey JS shell startup.
- Node/SpiderMonkey npm smoke if artifacts are available.

### Phase 5: Browser stress and cleanup

Tasks:

1. Add or update a browser stress harness that launches `/usr/bin/js` repeatedly on one persistent `BrowserKernel`.
2. Assert process memory is not allocated at `maxMemoryPages` on spawn.
3. Assert the first mmap no longer jumps to a fixed 64 MiB floor unless the allocation itself needs that much.
4. Assert exited processes and pthread slots are unregistered.
5. Remove the compatibility path only after all shipped binaries are rebuilt against the new layout ABI.

Validation target:

- Repeated browser-host launches of `/usr/bin/js` from the SpiderMonkey VFS run past 1500 iterations on one persistent `BrowserKernel`.
- No page reload.
- No kernel reset.
- No process leaks.
- No correctness dependency on browser garbage collection.
- Existing host lifecycle tests pass.

## Compatibility and migration

The first implementation should support both layouts:

- New binaries with `__wpk_control_*` exports use the pre-heap control slab and unified allocator.
- Old binaries use the current PR #595 low-control layout with `brk_limit`.

Once all first-party packages are rebuilt and browser stress passes, remove the old layout path in a separate cleanup PR.

## Deferred future work: reclaiming grown WebAssembly.Memory

WebAssembly.Memory can grow but cannot shrink. Even with a unified allocator, a process memory object keeps its high-water byte length until process exit and until all host/worker references are gone.

A possible future approach is to instrument `brk()` or a dedicated memory-compaction syscall similarly to fork instrumentation. The runtime could asyncify at a safe point, create a replacement process memory, copy only the live range up to the desired break/highest live VMA, recreate workers/channels against the new memory, and resume the process.

This is plausible but complex. It would need to preserve:

- process and thread register/stack state,
- pthread worker state,
- syscall channels,
- fd tables and kernel process metadata,
- shared mappings,
- framebuffer and device bindings,
- pending signals and wait state,
- host references to old SharedArrayBuffers.

Treat this as a later compaction project, not part of the unified allocator goal. The unified allocator should first minimize high-water growth by allocating densely and reusing holes.

## Success criteria

- New process initial memory is proportional to static data plus configured control slots, not `maxMemoryPages`.
- Normal mmap starts from the unified free-space map near `__heap_base`, not from a fixed 64 MiB base.
- brk, mmap, munmap, mremap, MAP_FIXED, fork, exec, and pthread creation are all mediated by one process address-space model.
- Host control memory is below `__heap_base` and does not require a brk stop line.
- Browser SpiderMonkey repeated-launch stress runs beyond 1500 iterations on one persistent kernel without OOM, process leaks, page reloads, or kernel resets.
