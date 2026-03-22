# Enable pthread_create in Centralized Mode

## Context

`pthread_create` already exists in musl and the kernel-side infrastructure (TID allocation, ThreadInfo, sys_clone) is complete. The missing piece is the **host-side `onClone` callback** that spawns thread Workers in centralized mode.

**Current call chain (working through to the gap):**
```
pthread_create → musl __clone → clone.c kernel_clone(fn,stack,flags,arg,ptid,tls,ctid)
  → JS stub dispatches SYS_CLONE through channel → kernel allocates TID
  → handleClone calls onClone(pid, 0/*fn*/, 0/*arg*/, stack, tls, ctid, memory)
  → onClone is NOT IMPLEMENTED → returns ENOSYS
```

**Two bugs in existing code:**
1. The `kernel_clone` JS stub in `centralizedWorkerMain` (worker-main.ts:1197) discards `fnPtr` and `argPtr` — only sends Linux syscall args (flags,stack,ptid,tls,ctid) through the channel
2. `handleClone` (kernel-worker.ts:1001) passes `0` for both fnPtr and argPtr to onClone

**Goal:** Wire up the complete flow so threads spawn, execute, and exit cleanly.

---

## Task 1: Pass fnPtr/argPtr through the channel

**Files:** `host/src/worker-main.ts`

In `centralizedWorkerMain` (line 1197), the `kernel_clone` JS stub writes syscall args to the channel but discards `fnPtr` and `arg`. Fix: write them to the CH_DATA area (offset 40) before setting PENDING.

**Step 1:** In the kernel_clone stub (lines 1198-1235), after `view.setInt32(base + 28, 0, true)` (line 1215), add:
```typescript
// Write fn_ptr and arg_ptr to CH_DATA area for handleClone to read
view.setUint32(base + 40, fnPtr, true);    // CH_DATA + 0
view.setUint32(base + 44, arg, true);      // CH_DATA + 4
```

**Step 2:** Verify `cd host && npx vitest run` still passes (no existing tests use centralized clone, so this is a no-regression check).

---

## Task 2: Read fnPtr/argPtr in handleClone + update onClone signature

**Files:** `host/src/kernel-worker.ts`

**Step 1:** Update `CentralizedKernelCallbacks.onClone` (line 333) to include `tid`:
```typescript
onClone?: (pid: number, fnPtr: number, argPtr: number, stackPtr: number,
           tlsPtr: number, ctidPtr: number, memory: WebAssembly.Memory,
           tid: number) => Promise<number>;
```

**Step 2:** In `handleClone` (line 951), before routing through kernel, read fnPtr/argPtr from the process channel's CH_DATA area:
```typescript
const processView = new DataView(channel.memory.buffer, channel.channelOffset);
const fnPtr = processView.getUint32(CH_DATA, true);
const argPtr = processView.getUint32(CH_DATA + 4, true);
```

**Step 3:** Update the `onClone` call (line 1000-1001) to pass actual values:
```typescript
this.callbacks.onClone(
  channel.pid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, channel.memory, tid,
)
```

**Step 4:** Add `addChannel` method to register a thread channel for an existing process:
```typescript
addChannel(pid: number, memory: WebAssembly.Memory, channelOffset: number): void
```
Creates ChannelInfo, adds to process registration's channels array and activeChannels, calls `listenOnChannel`.

**Step 5:** Add `removeChannel` method:
```typescript
removeChannel(pid: number, channelOffset: number): void
```
Removes from registration's channels and activeChannels.

**Step 6:** Modify `handleExit` (line 1013) to distinguish thread exit from process exit. If the channel is NOT the first channel for the process (i.e., it's a thread), just complete the channel and remove it — don't call `onExit`:
```typescript
const registration = this.processes.get(channel.pid);
const isMainThread = registration && registration.channels[0]?.channelOffset === channel.channelOffset;
// After routing through kernel and completing channel:
if (!isMainThread) {
  this.removeChannel(channel.pid, channel.channelOffset);
  return; // Don't call onExit for thread exits
}
```

**Step 7:** Verify `cd host && npx vitest run`.

---

## Task 3: Add CentralizedThreadInitMessage

**Files:** `host/src/worker-protocol.ts`

**Step 1:** Add the new type:
```typescript
export interface CentralizedThreadInitMessage {
  type: "centralized_thread_init";
  pid: number;
  tid: number;
  programBytes: ArrayBuffer;
  programModule?: WebAssembly.Module;
  memory: WebAssembly.Memory;
  channelOffset: number;
  fnPtr: number;
  argPtr: number;
  stackPtr: number;
  tlsPtr: number;
  ctidPtr: number;
}
```

**Step 2:** Add to the `HostToWorkerMessage` union (line 5).

**Step 3:** Verify `cd host && npx vitest run`.

---

## Task 4: Implement centralizedThreadWorkerMain

**Files:** `host/src/worker-main.ts`, `host/src/index.ts`

This is the thread entry point for centralized mode. Structurally similar to `centralizedWorkerMain` (channel dispatch) but calls `fn(arg)` via function table instead of `_start()`, and handles thread exit cleanup.

**Step 1:** Extract `buildChannelCloneStub(memory, channelOffset)` from the inline stub in `centralizedWorkerMain` (lines 1197-1235). Both `centralizedWorkerMain` and the new function will use it.

**Step 2:** Extract `threadExitCleanup(memory, tid, tlsPtr, ctidPtr)` from `threadWorkerMain` (lines 1106-1116) since both thread entry points need identical cleanup.

**Step 3:** Implement `centralizedThreadWorkerMain(port, initData: CentralizedThreadInitMessage)`:
- Compile/use programModule
- Build imports: `env: { memory }` + `kernel: { kernel_clone: buildChannelCloneStub(...) }` + stubs for other kernel imports
- Instantiate user program with shared Memory
- Init TLS: `memory.grow()` → `__wasm_init_tls(tlsBlock)`
- Set `__channel_base` via `__set_channel_base(channelOffset)` (or fallback TLS write)
- Set `__stack_pointer = stackPtr`
- Set thread pointer: `__wasm_thread_init(tlsPtr)`
- Copy start_args: `memory.grow(1)` → copy 256 bytes from argPtr (same pattern as threadWorkerMain:1076-1085)
- Call `funcTable.get(fnPtr)(argsCopyBase)`
- On exit/catch: `threadExitCleanup(...)`, post `thread_exit` message

**Step 4:** Refactor `centralizedWorkerMain` to use `buildChannelCloneStub`.

**Step 5:** Export from `host/src/index.ts`.

**Step 6:** Verify `cd host && npx vitest run`.

---

## Task 5: Add worker-entry dispatch

**Files:** `host/src/worker-entry.ts`

**Step 1:** Import `centralizedThreadWorkerMain` and `CentralizedThreadInitMessage`.

**Step 2:** Add dispatch case before the default:
```typescript
} else if (data.type === "centralized_thread_init") {
  centralizedThreadWorkerMain(parentPort, workerData as CentralizedThreadInitMessage).catch((e) => {
    console.error(`[worker-entry] centralizedThreadWorkerMain error: ${e}`);
  });
}
```

**Step 3:** Verify `cd host && npx vitest run`.

---

## Task 6: Implement onClone callback in ProcessManager

**Files:** `host/src/process-manager.ts`

The ProcessManager already has `this.config.centralizedKernel` and `handleCloneRequest` for non-centralized mode. Wire up onClone for centralized mode.

**Step 1:** Add a method to ProcessManager that returns the onClone callback:

```typescript
getOnCloneCallback(): CentralizedKernelCallbacks["onClone"] {
  return async (pid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory, tid) => {
    // 1. Allocate channel: grow memory by 2 pages
    const page = memory.grow(2);
    if (page === -1) throw new Error("Failed to grow memory for thread channel");
    const channelOffset = page * 65536;
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    // 2. Register channel with kernel worker
    this.config.centralizedKernel!.addChannel(pid, memory, channelOffset);

    // 3. Get parent's pre-compiled program module
    const parentInfo = this.processes.get(pid);
    const programBytes = parentInfo?.programBytes;
    const programModule = parentInfo?.programModule;

    // 4. Spawn thread Worker
    const threadInitData: CentralizedThreadInitMessage = {
      type: "centralized_thread_init",
      pid,
      tid,
      programBytes: programModule ? new ArrayBuffer(0) : programBytes!,
      programModule,
      memory,
      channelOffset,
      fnPtr,
      argPtr,
      stackPtr,
      tlsPtr,
      ctidPtr,
    };

    const threadWorker = this.config.workerAdapter.createWorker(threadInitData);

    // 5. Handle thread exit
    threadWorker.on("message", (msg: unknown) => {
      const m = msg as { type: string; tid?: number };
      if (m.type === "thread_exit") {
        this.config.centralizedKernel!.notifyThreadExit(pid, tid);
        this.config.centralizedKernel!.removeChannel(pid, channelOffset);
        threadWorker.terminate().catch(() => {});
      }
    });
    threadWorker.on("error", (err: Error) => {
      console.error(`[PM] thread ${tid} error: ${err.message}`);
      this.config.centralizedKernel!.notifyThreadExit(pid, tid);
      this.config.centralizedKernel!.removeChannel(pid, channelOffset);
    });

    return tid;
  };
}
```

**Step 2:** Verify `cd host && npx vitest run`.

---

## Task 7: Write integration test

**Step 1:** Create `examples/test-pthread.c`:
```c
#include <pthread.h>
#include <stdio.h>
#include <string.h>

static int shared_result = 0;

void *thread_fn(void *arg) {
    (void)arg;
    shared_result = 42;
    return NULL;
}

int main(void) {
    pthread_t t;
    int err = pthread_create(&t, NULL, thread_fn, NULL);
    if (err) {
        printf("pthread_create failed: %s\n", strerror(err));
        return 1;
    }
    err = pthread_join(t, NULL);
    if (err) {
        printf("pthread_join failed: %s\n", strerror(err));
        return 1;
    }
    if (shared_result != 42) {
        printf("FAIL: shared_result = %d (expected 42)\n", shared_result);
        return 1;
    }
    printf("PASS: pthread works, shared_result = %d\n", shared_result);
    return 0;
}
```

**Step 2:** Compile with channel_syscall.c:
```bash
$CC --target=wasm32-unknown-unknown --sysroot=sysroot -nostdlib -O2 \
  -matomics -mbulk-memory -fno-trapping-math \
  -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false \
  examples/test-pthread.c glue/channel_syscall.c glue/compiler_rt.c \
  sysroot/lib/crt1.o sysroot/lib/libc.a \
  -Wl,--entry=_start -Wl,--export=__wasm_init_tls \
  -Wl,--export=__set_channel_base -Wl,--export=__wasm_thread_init \
  -Wl,--export=__stack_pointer -Wl,--export=__tls_size \
  -Wl,--export=__indirect_function_table \
  -Wl,--shared-memory -Wl,--max-memory=1073741824 \
  -o examples/test-pthread.wasm
```

**Step 3:** Write a vitest integration test that:
1. Creates a CentralizedKernelWorker with onClone callback
2. Spawns the test program
3. Verifies output contains "PASS" and exit code is 0

**Step 4:** Run `cd host && npx vitest run` — all tests pass including new one.

---

## Task 8: Run libc-test and update XFAIL lists

**Step 1:** Run `scripts/run-libc-tests.sh --report` — check if any pthread tests now pass.

**Step 2:** Update XFAIL lists to remove any newly passing tests.

**Step 3:** Run `scripts/run-posix-tests.sh` — check for improvements.

**Step 4:** Update `docs/posix-incompatibilities.md` and `docs/wasm-limitations.md`.

---

## Verification

1. `cd host && npx vitest run` — all tests pass including new pthread integration test
2. `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` — 539 tests pass (no kernel changes)
3. `scripts/run-libc-tests.sh` — 0 unexpected failures
4. `scripts/run-posix-tests.sh` — 0 unexpected failures

## Files Summary

| File | Tasks |
|------|-------|
| `host/src/worker-main.ts` | 1, 4 |
| `host/src/kernel-worker.ts` | 2 |
| `host/src/worker-protocol.ts` | 3 |
| `host/src/worker-entry.ts` | 5 |
| `host/src/process-manager.ts` | 6 |
| `host/src/index.ts` | 4 |
| `examples/test-pthread.c` | 7 (new) |
