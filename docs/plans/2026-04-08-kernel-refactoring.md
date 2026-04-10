# Kernel Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move duplicated/misplaced host-side logic into shared utilities or the Rust kernel, improving maintainability and correctness.

**Architecture:** Three phases: (1) extract duplicated thread channel allocation into a shared TypeScript utility, (2) move SysV IPC and POSIX mqueue data structures from TypeScript into the Rust kernel, (3) replace host-side poll/select wakeup heuristics with kernel-driven readiness signaling.

**Tech Stack:** TypeScript (host runtime), Rust (kernel, no_std on wasm32), Vitest (integration tests), cargo test (unit tests)

---

## Phase 1: Thread Channel Page Allocation Utility

The `onClone` callback is copy-pasted across 9 files with a free-list-or-bump page allocator, memory zeroing, channel registration, and thread exit cleanup. Some use 3 pages per thread (no gap page), others use 4 (with gap page). Constants `CH_TOTAL_SIZE` and `MAX_PAGES` are redefined in 15+ files.

### Task 1: Create shared constants module

**Files:**
- Create: `host/src/constants.ts`
- Modify: `host/src/index.ts`

**Step 1: Create the constants file**

```typescript
// host/src/constants.ts

/** WebAssembly page size (64 KiB) */
export const WASM_PAGE_SIZE = 65536;

/** Channel header size in bytes */
export const CH_HEADER_SIZE = 40;

/** Channel data buffer size */
export const CH_DATA_SIZE = 65536;

/** Total channel size: header + data */
export const CH_TOTAL_SIZE = CH_HEADER_SIZE + CH_DATA_SIZE;

/** Default max pages for WebAssembly.Memory */
export const DEFAULT_MAX_PAGES = 16384;

/**
 * Pages allocated per thread: 2 for channel (65,576 bytes spills past one
 * 64 KiB page), 1 gap page, 1 for TLS.
 */
export const PAGES_PER_THREAD = 4;
```

**Step 2: Export from index.ts**

Add to `host/src/index.ts`:
```typescript
export { WASM_PAGE_SIZE, CH_TOTAL_SIZE, DEFAULT_MAX_PAGES, PAGES_PER_THREAD } from "./constants";
```

**Step 3: Run vitest to verify no breakage**

Run: `cd host && npx vitest run`
Expected: all tests pass (new file, no behavior change yet)

**Step 4: Commit**

```
feat: add shared constants module for channel/page layout
```

### Task 2: Create ThreadPageAllocator class

**Files:**
- Create: `host/src/thread-allocator.ts`
- Modify: `host/src/index.ts`

**Step 1: Create the allocator**

```typescript
// host/src/thread-allocator.ts
import { CH_TOTAL_SIZE, WASM_PAGE_SIZE, PAGES_PER_THREAD } from "./constants";

export interface ThreadAllocation {
  /** Base page number (highest page of the thread's region) */
  basePage: number;
  /** Byte offset of the channel in Memory */
  channelOffset: number;
  /** Byte offset of the TLS region in Memory */
  tlsAllocAddr: number;
}

/**
 * Manages thread channel page allocation within a WebAssembly.Memory.
 *
 * Pages are allocated top-down: the main process channel sits at the top
 * two pages, and each thread gets PAGES_PER_THREAD pages counting downward.
 * Freed pages go to a free list for reuse.
 */
export class ThreadPageAllocator {
  private nextPage: number;
  private freePages: number[] = [];
  private readonly pagesPerThread: number;

  constructor(maxPages: number, pagesPerThread = PAGES_PER_THREAD) {
    this.pagesPerThread = pagesPerThread;
    // Main channel occupies top 2 pages; first thread starts below that
    this.nextPage = maxPages - 2 - this.pagesPerThread;
  }

  /** Allocate pages for a new thread. Returns offsets needed for init. */
  allocate(memory: WebAssembly.Memory): ThreadAllocation {
    let basePage: number;
    if (this.freePages.length > 0) {
      basePage = this.freePages.pop()!;
    } else {
      basePage = this.nextPage;
      this.nextPage -= this.pagesPerThread;
    }

    const channelOffset = basePage * WASM_PAGE_SIZE;
    // TLS lives at the bottom page of the region
    const tlsAllocAddr = (basePage - (this.pagesPerThread - 1)) * WASM_PAGE_SIZE;

    // Zero channel and TLS regions
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
    new Uint8Array(memory.buffer, tlsAllocAddr, WASM_PAGE_SIZE).fill(0);

    return { basePage, channelOffset, tlsAllocAddr };
  }

  /** Return pages to the free list after thread exit. */
  free(basePage: number): void {
    this.freePages.push(basePage);
  }
}
```

**Step 2: Export from index.ts**

Add to `host/src/index.ts`:
```typescript
export { ThreadPageAllocator } from "./thread-allocator";
export type { ThreadAllocation } from "./thread-allocator";
```

**Step 3: Run vitest**

Run: `cd host && npx vitest run`
Expected: all tests pass (new file, no behavior change yet)

**Step 4: Commit**

```
feat: add ThreadPageAllocator for onClone deduplication
```

### Task 3: Migrate onClone implementations to use ThreadPageAllocator

**Files to modify (9 files):**
1. `examples/run-example.ts`
2. `examples/mariadb/serve.ts`
3. `examples/redis/serve.ts`
4. `examples/shell/serve.ts`
5. `examples/wordpress/serve.ts`
6. `examples/lamp/serve.ts`
7. `examples/browser/lib/kernel-worker-entry.ts`
8. `host/test/centralized-test-helper.ts`
9. `examples/wordpress/test/wordpress-server.test.ts`

For each file, the migration follows this pattern:

**Before (example from run-example.ts):**
```typescript
const CH_TOTAL_SIZE = 40 + 65536;
const MAX_PAGES = 16384;
let nextThreadChannelPage = MAX_PAGES - 4;
const freeThreadPages: number[] = [];

// ... in onClone:
let basePage: number;
if (freeThreadPages.length > 0) {
    basePage = freeThreadPages.pop()!;
} else {
    basePage = nextThreadChannelPage;
    nextThreadChannelPage -= 3;
}
const threadChannelOffset = basePage * 65536;
const tlsAllocAddr = (basePage - 2) * 65536;
new Uint8Array(memory.buffer, threadChannelOffset, CH_TOTAL_SIZE).fill(0);
new Uint8Array(memory.buffer, tlsAllocAddr, 65536).fill(0);
```

**After:**
```typescript
import { ThreadPageAllocator } from "wasm-posix-kernel";
// or relative: import { ThreadPageAllocator } from "../host/src/thread-allocator";

const threadAllocator = new ThreadPageAllocator(MAX_PAGES);

// ... in onClone:
const alloc = threadAllocator.allocate(memory);

// ... in thread exit handler:
threadAllocator.free(alloc.basePage);
```

**Step 1: Migrate all 9 files**

Do them in one batch — each follows the same mechanical pattern:
1. Add import for `ThreadPageAllocator` (and `CH_TOTAL_SIZE` from constants if still needed elsewhere)
2. Replace `nextThreadChannelPage` + `freeThreadPages` declarations with `new ThreadPageAllocator(maxPages)`
3. Replace allocation block in `onClone` with `threadAllocator.allocate(memory)`
4. Use `alloc.channelOffset`, `alloc.tlsAllocAddr`, `alloc.basePage`
5. Replace `freeThreadPages.push(basePage)` with `threadAllocator.free(alloc.basePage)` in exit/error handlers
6. Remove local `CH_TOTAL_SIZE` definitions that are no longer used (keep if used elsewhere in file)

**NOTE on 3-vs-4 page standardization:** Files currently using 3 pages (run-example, shell, centralized-test-helper, wordpress-server.test) will now use 4 pages. This adds a gap page between channel and TLS — strictly safer, no functional change. The `nextThreadChannelPage` initial value doesn't change since it was already `MAX_PAGES - 4` in all files except `run-example.ts` which used `MAX_PAGES - 2 - 3`. The new allocator standardizes on `MAX_PAGES - 2 - PAGES_PER_THREAD`.

**Step 2: Also replace duplicated CH_TOTAL_SIZE/MAX_PAGES constants**

Where these constants are defined locally and no longer used (only needed for the now-removed allocation code), remove them and import from constants.ts. Where they're still used (e.g., kernel-worker.ts uses CH_TOTAL_SIZE for channel layout), leave them — kernel-worker.ts internal constants serve a different purpose (full channel layout with signal offsets).

**Step 3: Run full test suite**

Run:
```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
cd host && npx vitest run
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
```
Expected: all pass with no regressions

**Step 4: Commit**

```
refactor: deduplicate onClone thread page allocation into ThreadPageAllocator
```

---

## Phase 2: SysV IPC & POSIX Mqueues → Rust Kernel

Currently `SharedIpcTable` (SysV IPC, 1195 lines, SharedArrayBuffer-backed) and `PosixMqueueTable` (POSIX mqueues, 363 lines) live entirely in TypeScript, intercepted before reaching the kernel. Moving them to Rust:
- Lets `remove_process()` handle IPC resource cleanup
- Eliminates two TypeScript classes and ~1600 lines of host code
- Makes IPC consistent with pipes/sockets/FDs (all kernel-managed)

**Data flow after refactoring:** The host still marshals data between process memory and the kernel scratch area (same pattern as read/write/stat). The kernel handles all IPC logic and storage.

### Task 4: Add POSIX mqueue data structures to Rust kernel

**Files:**
- Create: `crates/kernel/src/mqueue.rs`
- Modify: `crates/kernel/src/lib.rs` (add module)

**Step 1: Implement MqueueTable in Rust**

Implement these data structures matching the existing PosixMqueueTable semantics:
- `MqMessage { data: Vec<u8>, priority: u32 }`
- `MqQueue { name: Vec<u8>, maxmsg: u32, msgsize: u32, messages: Vec<MqMessage>, unlinked: bool, open_count: u32, notification: Option<(u32, u32)>, mode: u32 }`
- `MqDescriptor { queue_idx: usize, access_mode: u32, nonblock: bool }`
- `MqueueTable { queues: Vec<Option<MqQueue>>, descriptors: BTreeMap<u32, MqDescriptor>, next_mqd: u32 }`

Methods: `mq_open`, `mq_close`, `mq_unlink`, `mq_send`, `mq_receive`, `mq_notify`, `mq_getsetattr`, `cleanup_process`, `is_mqd`.

MQD_BASE = 0x40000000 (same as current TypeScript implementation).

**Step 2: Write Rust unit tests**

Test: create queue, send/receive with priority ordering, unlink semantics, O_NONBLOCK EAGAIN, notification registration, cleanup_process.

**Step 3: Run cargo tests**

Run: `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
Expected: new tests pass, all existing tests still pass

**Step 4: Commit**

```
feat: add POSIX mqueue data structures to Rust kernel
```

### Task 5: Wire POSIX mqueue syscalls through kernel

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` (add mqueue syscall handlers)
- Modify: `crates/kernel/src/wasm_api.rs` (add mqueue to dispatch)
- Modify: `crates/kernel/src/process_table.rs` (add mqueue cleanup to `remove_process`)
- Modify: `host/src/kernel-worker.ts` (remove mqueue interception, add scratch marshalling)

**Step 1: Add syscall handlers in Rust**

For each of SYS_MQ_OPEN (331) through SYS_MQ_GETSETATTR (336), add handlers that:
- Read args from channel scratch (same as other syscalls)
- For data payloads (message data, queue name, mq_attr struct), read from the channel data area where the host placed them
- Call MqueueTable methods
- Write results (received message data, mq_attr) to channel data area
- Return result value

**Step 2: Update host-side dispatch**

Remove the mqueue interception block (lines 1495-1507 in kernel-worker.ts). Instead, add mqueue arg marshalling to the normal syscall path:
- SYS_MQ_OPEN: copy name string from process memory to scratch data area
- SYS_MQ_TIMEDSEND: copy message data from process memory to scratch data area
- SYS_MQ_TIMEDRECEIVE: after kernel returns, copy message data from scratch to process memory
- SYS_MQ_NOTIFY: copy sigevent struct from process memory to scratch
- SYS_MQ_GETSETATTR: copy mq_attr to/from scratch
- SYS_CLOSE for mqds: remove the `isMqd` check; the kernel handles it

Also handle mq_notify's signal delivery: when kernel returns a notification-needed flag, the host calls `kernel_send_signal(pid, signo)`.

**Step 3: Add mqueue cleanup to remove_process**

In `process_table.rs`, call `mqueue_table.cleanup_process(pid)` to remove notifications for the exiting process.

**Step 4: Run full test suite**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
cd host && npx vitest run
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
```

**Step 5: Commit**

```
refactor: move POSIX mqueue handling from TypeScript to Rust kernel
```

### Task 6: Add SysV IPC data structures to Rust kernel

**Files:**
- Create: `crates/kernel/src/ipc.rs`
- Modify: `crates/kernel/src/lib.rs`

**Step 1: Implement IPC tables in Rust**

Port the SharedIpcTable's three subsystems:

**Message queues:**
- `MsgQueue { key, id, mode, uid/gid, cuid/cgid, qbytes, messages: VecDeque<(i32, Vec<u8>)>, stime/rtime/ctime, lspid/lrpid, seq }`
- `msgget(key, flags, pid, uid, gid)`, `msgsnd(qid, mtype, data, flags, pid)`, `msgrcv(qid, maxsize, msgtype, flags, pid)`, `msgctl(qid, cmd, pid)`

**Semaphores:**
- `SemSet { key, id, mode, uid/gid, cuid/cgid, nsems, values: Vec<SemValue>, otime, ctime, seq }`
- `SemValue { val: u16, pid: u32, ncnt: u32, zcnt: u32 }`
- `semget`, `semop` (two-pass: validate then apply), `semctl`

**Shared memory:**
- `ShmSegment { key, id, mode, uid/gid, cuid/cgid, segsz, data: Vec<u8>, cpid, lpid, nattch, atime/dtime/ctime, seq }`
- `shmget`, `shmat` (returns data slice + increments nattch), `shmdt` (updates data + decrements nattch), `shmctl`

For shared memory, the segment data lives in kernel memory. The host will transfer data between kernel and process memory in chunks through the scratch area. New kernel exports:
- `kernel_shm_read_chunk(shmid, offset, len)` → writes chunk to scratch data area
- `kernel_shm_write_chunk(shmid, offset, len)` → reads chunk from scratch data area

**Step 2: Write Rust unit tests**

Test all IPC operations: create/destroy, permission checks, message type filtering (positive, negative, MSG_EXCEPT), semaphore atomicity (two-pass validation), shm attach/detach lifecycle.

**Step 3: Run cargo tests**

Run: `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`

**Step 4: Commit**

```
feat: add SysV IPC data structures to Rust kernel
```

### Task 7: Wire SysV IPC syscalls through kernel

**Files:**
- Modify: `crates/kernel/src/syscalls.rs`
- Modify: `crates/kernel/src/wasm_api.rs`
- Modify: `crates/kernel/src/process_table.rs`
- Modify: `host/src/kernel-worker.ts`

**Step 1: Add syscall handlers in Rust for SYS_MSGGET (337) through SYS_SHMCTL (347)**

Same pattern as mqueue: read args from scratch, read/write data from scratch data area, call IPC table methods, return results.

For shmat: kernel does mmap (allocate process address space via existing mmap logic), returns the address + segment size. Separately, the host uses `kernel_shm_read_chunk` to transfer segment data to process memory at that address in 64KB chunks.

For shmdt: host uses `kernel_shm_write_chunk` to transfer data from process memory back to kernel in chunks, then calls the shmdt syscall for bookkeeping.

**Step 2: Update host-side dispatch**

Remove the SysV IPC interception block (lines 1486-1493). Add IPC arg marshalling to the normal syscall path:
- MSGSND: copy message `{mtype, mtext}` from process memory to scratch data area
- MSGRCV: after kernel returns, copy message from scratch to process memory
- MSGCTL IPC_STAT: after kernel returns, copy msqid_ds from scratch to process memory
- SEMOP: copy sembuf array from process memory to scratch
- SEMCTL: marshal scalar/array args through scratch
- SHMGET/SHMCTL: marshal struct args through scratch
- SHMAT: multi-step: call kernel for mmap+attach, then chunk-copy data to process memory
- SHMDT: chunk-copy data from process memory, then call kernel for detach

**Step 3: Add IPC cleanup to remove_process**

`remove_process()` doesn't destroy IPC objects (SysV IPC persists until IPC_RMID), but it should update `nattch` for attached shm segments and clean up process-specific state.

**Step 4: Delete SharedIpcTable and PosixMqueueTable**

- Remove `host/src/shared-ipc-table.ts`
- Remove `host/src/posix-mqueue.ts`
- Remove exports from `host/src/index.ts`
- Remove `ipcTable`, `shmMappings`, `mqueueTable` fields from CentralizedKernelWorker
- Remove all `handleIpc*` and `handleMqueue*` methods

**Step 5: Run full test suite**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
cd host && npx vitest run
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
```

**Step 6: Commit**

```
refactor: move SysV IPC from TypeScript to Rust kernel, delete SharedIpcTable
```

---

## Phase 3: Kernel-Driven Poll/Select Wakeup

The host maintains `POLL_AFFECTING_SYSCALLS`, `pendingPipeWriters`, `pendingPipeReaders`, and `wakeAllBlockedRetries` to guess when blocked poll/select should retry. The kernel already knows pipe buffer state — it can signal readiness directly.

### Task 8: Add pipe readiness change tracking to kernel

**Files:**
- Modify: `crates/kernel/src/pipe.rs` (add wakeup tracking)
- Create or modify: `crates/kernel/src/wakeup.rs` (wakeup event buffer)
- Modify: `crates/kernel/src/wasm_api.rs` (new exports)

**Step 1: Add a wakeup event buffer**

After each syscall that changes pipe readiness (read drains buffer → writers can proceed, write fills buffer → readers can proceed, close → POLLHUP), the kernel appends the affected pipe index to a global wakeup buffer.

```rust
// Wakeup event types
pub const WAKE_READABLE: u8 = 1;  // pipe became readable (data written or write-end closed)
pub const WAKE_WRITABLE: u8 = 2;  // pipe became writable (data read or read-end closed)

pub struct WakeupEvent {
    pub pipe_idx: u32,
    pub wake_type: u8,
}

static WAKEUP_BUFFER: Mutex<Vec<WakeupEvent>> = ...;
```

**Step 2: Instrument pipe operations**

In `PipeBuffer::write()`: if buffer was empty and now has data → push `WAKE_READABLE`.
In `PipeBuffer::read()`: if buffer was full and now has space → push `WAKE_WRITABLE`.
In `close_read_end()`: push `WAKE_WRITABLE` (writers get EPIPE/SIGPIPE).
In `close_write_end()`: push `WAKE_READABLE` (readers get EOF/POLLHUP).

**Step 3: Add kernel export**

```rust
#[no_mangle]
pub extern "C" fn kernel_drain_wakeup_events(buf_ptr: *mut u8, max_events: u32) -> u32
```

Writes `(pipe_idx: u32, wake_type: u8)` pairs to the buffer, returns count. Clears the buffer.

**Step 4: Write Rust unit tests**

Test: write to pipe generates WAKE_READABLE, read generates WAKE_WRITABLE, close generates appropriate events, drain clears buffer.

**Step 5: Commit**

```
feat: add pipe readiness wakeup tracking to kernel
```

### Task 9: Replace host-side wakeup heuristics with kernel events

**Files:**
- Modify: `host/src/kernel-worker.ts`

**Step 1: Call kernel_drain_wakeup_events after each syscall**

In `completeChannel()`, after `kernel_handle_channel` returns, call `kernel_drain_wakeup_events` to get the list of pipe indices that changed readiness.

**Step 2: Replace POLL_AFFECTING_SYSCALLS with targeted wakeups**

Instead of checking `POLL_AFFECTING_SYSCALLS.has(syscallNr)` and calling `scheduleWakeBlockedRetries()` (which wakes ALL pending polls), use the wakeup events to:
- Wake only `pendingPipeReaders` whose pipe index is in the WAKE_READABLE set
- Wake only `pendingPipeWriters` whose pipe index is in the WAKE_WRITABLE set
- Wake only `pendingPollRetries` whose `pipeIndices` list intersects the changed set

**Step 3: Remove POLL_AFFECTING_SYSCALLS, READ_LIKE_SYSCALLS, WRITE_LIKE_SYSCALLS**

These are no longer needed — the kernel tells us exactly what changed.

**Step 4: Simplify wakePendingPipeReaders/Writers**

These currently resolve pipe indices from fd numbers via kernel exports. With kernel-driven events, we already have the pipe index — wake directly by pipe index.

**Step 5: Keep existing mechanisms that can't move to kernel**

- `pendingPollRetries` timer-based retry (for timeout handling)
- `pendingSelectRetries` (same)
- `wakeBlockedPoll(pid, pipeIdx)` for TCP injection path
- The epoll V8 workaround
- FUTEX wakeup (uses Atomics, must stay host-side)

**Step 6: Run full test suite**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
cd host && npx vitest run
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
scripts/run-sortix-tests.sh --all
```

**Step 7: Commit**

```
refactor: replace host-side poll wakeup heuristics with kernel-driven readiness events
```

---

## Test Checkpoints

Run the full suite after each phase:

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib   # 610+ tests
cd host && npx vitest run                                              # 227+ tests
scripts/run-libc-tests.sh                                              # 0 FAIL
scripts/run-posix-tests.sh                                             # 0 FAIL
scripts/run-sortix-tests.sh --all                                      # 0 FAIL, 0 XPASS
```

Any regression means stop and fix before proceeding to the next phase.
