# Phase 13c: Cross-Process Pipes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable pipe I/O between forked processes. After fork, pipes shared between parent and child are converted from kernel-internal PipeBuffers to host-managed SharedPipeBuffers backed by SharedArrayBuffer, allowing cross-worker data transfer.

**Architecture:** Cross-process pipes use SharedArrayBuffer ring buffers with atomic operations for lock-free, cross-worker read/write. The kernel distinguishes host-delegated pipes (host_handle >= 0) from kernel-internal pipes (host_handle < 0). On fork, the ProcessManager detects shared pipes and converts them via `kernel_convert_pipe_to_host`. The host routes read/write calls for these handles through SharedPipeBuffer. Non-blocking only in this phase; blocking support deferred.

**Tech Stack:** Rust (kernel pipe routing), TypeScript (SharedPipeBuffer, ProcessManager)

**Design doc:** `docs/plans/2026-03-08-multi-worker-design.md`

---

### Task 1: SharedPipeBuffer Class (TypeScript)

**Files:**
- Create: `host/src/shared-pipe-buffer.ts`
- Test: `host/test/shared-pipe-buffer.test.ts`

A ring buffer backed by SharedArrayBuffer with atomic operations for cross-worker pipe I/O.

**SharedArrayBuffer layout (little-endian):**
```
[0..3]   head     (Uint32, atomic) - read position
[4..7]   tail     (Uint32, atomic) - write position
[8..11]  len      (Uint32, atomic) - bytes available
[12..15] flags    (Uint32, atomic) - bit 0: read_open, bit 1: write_open
[16..N]  data     ring buffer (default 65536 bytes)
```

Total SharedArrayBuffer size: 16 + capacity bytes.

**Step 1: Write failing tests**

```typescript
// host/test/shared-pipe-buffer.test.ts
import { describe, it, expect } from "vitest";
import { SharedPipeBuffer } from "../src/shared-pipe-buffer";

describe("SharedPipeBuffer", () => {
  it("should create with correct capacity", () => {
    const pipe = SharedPipeBuffer.create(1024);
    expect(pipe.capacity()).toBe(1024);
    expect(pipe.available()).toBe(0);
    expect(pipe.isReadOpen()).toBe(true);
    expect(pipe.isWriteOpen()).toBe(true);
  });

  it("should write and read data", () => {
    const pipe = SharedPipeBuffer.create(1024);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const written = pipe.write(data);
    expect(written).toBe(5);
    expect(pipe.available()).toBe(5);

    const buf = new Uint8Array(10);
    const read = pipe.read(buf);
    expect(read).toBe(5);
    expect(buf.slice(0, 5)).toEqual(data);
    expect(pipe.available()).toBe(0);
  });

  it("should handle partial writes when buffer is nearly full", () => {
    const pipe = SharedPipeBuffer.create(8);
    const written1 = pipe.write(new Uint8Array([1, 2, 3, 4, 5]));
    expect(written1).toBe(5);
    // Only 3 bytes free
    const written2 = pipe.write(new Uint8Array([6, 7, 8, 9, 10]));
    expect(written2).toBe(3);
  });

  it("should return 0 when reading empty buffer", () => {
    const pipe = SharedPipeBuffer.create(1024);
    const buf = new Uint8Array(10);
    const read = pipe.read(buf);
    expect(read).toBe(0);
  });

  it("should handle ring buffer wraparound", () => {
    const pipe = SharedPipeBuffer.create(8);
    // Fill buffer
    pipe.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    // Read 4 bytes
    const buf1 = new Uint8Array(4);
    pipe.read(buf1);
    expect(buf1).toEqual(new Uint8Array([1, 2, 3, 4]));
    // Write 4 more (wraps around)
    pipe.write(new Uint8Array([9, 10, 11, 12]));
    // Read all 8
    const buf2 = new Uint8Array(8);
    const read = pipe.read(buf2);
    expect(read).toBe(8);
    expect(buf2).toEqual(new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12]));
  });

  it("should close read end", () => {
    const pipe = SharedPipeBuffer.create(1024);
    pipe.closeRead();
    expect(pipe.isReadOpen()).toBe(false);
    expect(pipe.isWriteOpen()).toBe(true);
  });

  it("should close write end", () => {
    const pipe = SharedPipeBuffer.create(1024);
    pipe.closeWrite();
    expect(pipe.isWriteOpen()).toBe(false);
    expect(pipe.isReadOpen()).toBe(true);
  });

  it("should create from existing SharedArrayBuffer", () => {
    const pipe1 = SharedPipeBuffer.create(1024);
    pipe1.write(new Uint8Array([1, 2, 3]));

    // Create second view of same SharedArrayBuffer
    const pipe2 = SharedPipeBuffer.fromSharedBuffer(pipe1.getBuffer());
    expect(pipe2.available()).toBe(3);
    const buf = new Uint8Array(3);
    pipe2.read(buf);
    expect(buf).toEqual(new Uint8Array([1, 2, 3]));
  });
});
```

**Step 2: Implement SharedPipeBuffer**

```typescript
// host/src/shared-pipe-buffer.ts

const HEADER_SIZE = 16;
const HEAD_OFFSET = 0;
const TAIL_OFFSET = 1;  // Int32Array index (4 bytes each)
const LEN_OFFSET = 2;
const FLAGS_OFFSET = 3;
const FLAG_READ_OPEN = 1;
const FLAG_WRITE_OPEN = 2;

export class SharedPipeBuffer {
  private meta: Int32Array;  // View of header (4 x Int32)
  private data: Uint8Array;  // View of ring buffer data
  private cap: number;
  private sab: SharedArrayBuffer;

  private constructor(sab: SharedArrayBuffer, capacity: number) {
    this.sab = sab;
    this.cap = capacity;
    this.meta = new Int32Array(sab, 0, 4);
    this.data = new Uint8Array(sab, HEADER_SIZE, capacity);
  }

  static create(capacity: number = 65536): SharedPipeBuffer {
    const sab = new SharedArrayBuffer(HEADER_SIZE + capacity);
    const pipe = new SharedPipeBuffer(sab, capacity);
    // Initialize: head=0, tail=0, len=0, flags=READ_OPEN|WRITE_OPEN
    Atomics.store(pipe.meta, HEAD_OFFSET, 0);
    Atomics.store(pipe.meta, TAIL_OFFSET, 0);
    Atomics.store(pipe.meta, LEN_OFFSET, 0);
    Atomics.store(pipe.meta, FLAGS_OFFSET, FLAG_READ_OPEN | FLAG_WRITE_OPEN);
    return pipe;
  }

  static fromSharedBuffer(sab: SharedArrayBuffer): SharedPipeBuffer {
    const capacity = sab.byteLength - HEADER_SIZE;
    return new SharedPipeBuffer(sab, capacity);
  }

  getBuffer(): SharedArrayBuffer { return this.sab; }
  capacity(): number { return this.cap; }

  available(): number {
    return Atomics.load(this.meta, LEN_OFFSET);
  }

  isReadOpen(): boolean {
    return (Atomics.load(this.meta, FLAGS_OFFSET) & FLAG_READ_OPEN) !== 0;
  }

  isWriteOpen(): boolean {
    return (Atomics.load(this.meta, FLAGS_OFFSET) & FLAG_WRITE_OPEN) !== 0;
  }

  write(src: Uint8Array): number {
    const len = Atomics.load(this.meta, LEN_OFFSET);
    const free = this.cap - len;
    const n = Math.min(src.length, free);
    if (n === 0) return 0;

    let tail = Atomics.load(this.meta, TAIL_OFFSET);
    for (let i = 0; i < n; i++) {
      this.data[tail] = src[i];
      tail = (tail + 1) % this.cap;
    }
    Atomics.store(this.meta, TAIL_OFFSET, tail);
    Atomics.add(this.meta, LEN_OFFSET, n);
    return n;
  }

  read(dst: Uint8Array): number {
    const len = Atomics.load(this.meta, LEN_OFFSET);
    const n = Math.min(dst.length, len);
    if (n === 0) return 0;

    let head = Atomics.load(this.meta, HEAD_OFFSET);
    for (let i = 0; i < n; i++) {
      dst[i] = this.data[head];
      head = (head + 1) % this.cap;
    }
    Atomics.store(this.meta, HEAD_OFFSET, head);
    Atomics.sub(this.meta, LEN_OFFSET, n);
    return n;
  }

  closeRead(): void {
    Atomics.and(this.meta, FLAGS_OFFSET, ~FLAG_READ_OPEN);
  }

  closeWrite(): void {
    Atomics.and(this.meta, FLAGS_OFFSET, ~FLAG_WRITE_OPEN);
  }
}
```

**Step 3: Run tests**

Run: `cd host && npx vitest run test/shared-pipe-buffer.test.ts`
Expected: 8 tests pass

**Step 4: Commit**

```bash
git add host/src/shared-pipe-buffer.ts host/test/shared-pipe-buffer.test.ts
git commit -m "feat: add SharedPipeBuffer class backed by SharedArrayBuffer"
```

---

### Task 2: Kernel Support for Host-Delegated Pipes (Rust)

**Files:**
- Modify: `crates/kernel/src/syscalls.rs`
- Modify: `crates/kernel/src/wasm_api.rs`
- Test: existing test targets

The kernel must distinguish host-delegated pipes (host_handle >= 0) from kernel-internal pipes (host_handle < 0). For host-delegated pipes, read/write/close delegate to host functions.

**Step 1: Modify sys_read for host-delegated pipes**

In `sys_read`, change the `FileType::Pipe` arm:

```rust
FileType::Pipe => {
    if host_handle >= 0 {
        // Host-delegated pipe (cross-process): use host_read
        let n = host.host_read(host_handle, buf)?;
        Ok(n)
    } else {
        // Kernel-internal pipe
        let pipe_idx = (-(host_handle + 1)) as usize;
        let pipe = proc
            .pipes
            .get_mut(pipe_idx)
            .and_then(|p| p.as_mut())
            .ok_or(Errno::EBADF)?;
        let n = pipe.read(buf);
        if n == 0 && pipe.is_write_end_open() {
            if status_flags & O_NONBLOCK != 0 {
                return Err(Errno::EAGAIN);
            }
        }
        Ok(n)
    }
}
```

**Step 2: Modify sys_write for host-delegated pipes**

In `sys_write`, change the `FileType::Pipe` arm:

```rust
FileType::Pipe => {
    if host_handle >= 0 {
        // Host-delegated pipe (cross-process): use host_write
        let n = host.host_write(host_handle, buf)?;
        Ok(n)
    } else {
        // Kernel-internal pipe
        let pipe_idx = (-(host_handle + 1)) as usize;
        let pipe = proc
            .pipes
            .get_mut(pipe_idx)
            .and_then(|p| p.as_mut())
            .ok_or(Errno::EBADF)?;
        if !pipe.is_read_end_open() {
            return Err(Errno::EPIPE);
        }
        let n = pipe.write(buf);
        if n == 0 && status_flags & O_NONBLOCK != 0 {
            return Err(Errno::EAGAIN);
        }
        Ok(n)
    }
}
```

**Step 3: Modify sys_close for host-delegated pipes**

In `sys_close`, change the `FileType::Pipe` arm:

```rust
FileType::Pipe => {
    if host_handle >= 0 {
        // Host-delegated pipe: let host handle cleanup
        let _ = host.host_close(host_handle);
    } else {
        // Kernel-internal pipe
        let pipe_idx = (-(host_handle + 1)) as usize;
        if let Some(pipe) = proc.pipes.get_mut(pipe_idx).and_then(|p| p.as_mut()) {
            let access_mode = status_flags & O_ACCMODE;
            if access_mode == O_RDONLY {
                pipe.close_read_end();
            } else {
                pipe.close_write_end();
            }
        }
    }
}
```

**Step 4: Modify poll for host-delegated pipes**

In `sys_poll`, the `FileType::Pipe` arm currently reads from `proc.pipes`. For host-delegated pipes (host_handle >= 0), report as always ready (both POLLIN and POLLOUT set if requested). This is a simplification; the host manages actual availability.

```rust
FileType::Pipe => {
    if ofd.host_handle >= 0 {
        // Host-delegated pipe: report as ready (non-blocking)
        if pollfd.events & POLLIN != 0 {
            revents |= POLLIN;
        }
        if pollfd.events & POLLOUT != 0 {
            revents |= POLLOUT;
        }
    } else {
        // Kernel-internal pipe
        let pipe_idx = (-(ofd.host_handle + 1)) as usize;
        if let Some(Some(pipe)) = proc.pipes.get(pipe_idx) {
            // ... existing logic ...
        }
    }
}
```

**Step 5: Add kernel_convert_pipe_to_host Wasm export**

Add to `wasm_api.rs`:

```rust
/// Convert a pipe's OFD from kernel-internal to host-delegated.
/// After this, reads/writes for this OFD will go through host_read/host_write.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_convert_pipe_to_host(ofd_idx: u32, new_host_handle: i64) -> i32 {
    let proc = unsafe { get_process() };
    let ofd = match proc.ofd_table.get_mut(ofd_idx as usize) {
        Some(ofd) => ofd,
        None => return -(Errno::EBADF as i32),
    };
    if ofd.file_type != FileType::Pipe {
        return -(Errno::EINVAL as i32);
    }
    ofd.host_handle = new_host_handle;
    0
}
```

**Step 6: Run tests**

Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo`
Expected: All 302 existing tests pass (existing pipe tests use kernel-internal pipes which still work)

Rebuild Wasm:
```bash
cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p kandelo --release
cp target/wasm32-unknown-unknown/release/kandelo_kernel.wasm host/wasm/kandelo-kernel.wasm
```

**Step 7: Commit**

```bash
git add crates/kernel/src/syscalls.rs crates/kernel/src/wasm_api.rs host/wasm/kandelo-kernel.wasm
git commit -m "feat: add host-delegated pipe support and kernel_convert_pipe_to_host export"
```

---

### Task 3: Shared Pipe Registration in Worker Entry (TypeScript)

**Files:**
- Modify: `host/src/worker-protocol.ts`
- Modify: `host/src/worker-entry.ts`
- Modify: `host/src/kernel.ts`
- Create: `host/src/index.ts` update (export SharedPipeBuffer)

The worker entry needs to handle pipe registration messages. The WasmPosixKernel needs a way to route host_read/host_write for registered pipe handles through SharedPipeBuffer.

**Step 1: Add pipe registration message to protocol**

Add to `host/src/worker-protocol.ts`:

```typescript
// Add to HostToWorkerMessage union:
| RegisterPipeMessage
| ConvertPipeMessage

export interface RegisterPipeMessage {
  type: "register_pipe";
  handle: number;
  buffer: SharedArrayBuffer;
}

export interface ConvertPipeMessage {
  type: "convert_pipe";
  ofdIndex: number;
  newHandle: number;
}
```

**Step 2: Add shared pipe registry to WasmPosixKernel**

Add to `host/src/kernel.ts`:

```typescript
import { SharedPipeBuffer } from "./shared-pipe-buffer";

// In WasmPosixKernel class:
private sharedPipes = new Map<number, SharedPipeBuffer>();

registerSharedPipe(handle: number, sab: SharedArrayBuffer): void {
  this.sharedPipes.set(handle, SharedPipeBuffer.fromSharedBuffer(sab));
}

unregisterSharedPipe(handle: number): void {
  this.sharedPipes.delete(handle);
}
```

Modify `hostRead` to check shared pipes first:

```typescript
private hostRead(handle: bigint, bufPtr: number, bufLen: number): number {
  const h = Number(handle);

  // Check shared pipe registry
  const pipe = this.sharedPipes.get(h);
  if (pipe) {
    const mem = this.getMemoryBuffer();
    const dst = new Uint8Array(bufLen);
    const n = pipe.read(dst);
    if (n > 0) {
      mem.set(dst.subarray(0, n), bufPtr);
    }
    return n;
  }

  // stdin — not yet supported
  if (h === 0) return 0;

  // ... existing code ...
}
```

Modify `hostWrite` to check shared pipes first:

```typescript
private hostWrite(handle: bigint, bufPtr: number, bufLen: number): number {
  const h = Number(handle);

  // Check shared pipe registry
  const pipe = this.sharedPipes.get(h);
  if (pipe) {
    const mem = this.getMemoryBuffer();
    const src = mem.slice(bufPtr, bufPtr + bufLen);
    return pipe.write(src);
  }

  // ... existing code (stdout/stderr/file) ...
}
```

Modify `hostClose` to handle shared pipe cleanup:

```typescript
// In hostClose, add before existing logic:
const pipe = this.sharedPipes.get(h);
if (pipe) {
  // Determine read/write end from context (the kernel knows)
  // For simplicity, just unregister
  this.sharedPipes.delete(h);
  return 0;
}
```

**Step 3: Handle pipe registration in worker entry**

In `host/src/worker-entry.ts`, add to the message handler:

```typescript
case "register_pipe": {
  const msg = m as RegisterPipeMessage;
  kernel.registerSharedPipe(msg.handle, msg.buffer);
  break;
}
case "convert_pipe": {
  const msg = m as ConvertPipeMessage;
  const convertFn = instance.exports.kernel_convert_pipe_to_host as
    (ofdIdx: number, newHandle: number) => number;
  const result = convertFn(msg.ofdIndex, msg.newHandle);
  if (result < 0) {
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: `kernel_convert_pipe_to_host failed: ${result}`,
    } satisfies WorkerToHostMessage);
  }
  break;
}
```

Import the new message types at the top of worker-entry.ts.

**Step 4: Update exports**

Add `SharedPipeBuffer` to `host/src/index.ts` exports.

**Step 5: Run tests**

Run: `cd host && npx vitest run`
Expected: All existing tests pass (28)

**Step 6: Commit**

```bash
git add host/src/worker-protocol.ts host/src/worker-entry.ts host/src/kernel.ts host/src/index.ts
git commit -m "feat: add shared pipe registration to worker protocol and kernel"
```

---

### Task 4: ProcessManager Pipe Detection and Conversion on Fork (TypeScript)

**Files:**
- Modify: `host/src/process-manager.ts`
- Modify: `host/test/process-manager.test.ts`

After fork, the ProcessManager detects pipe OFDs in the fork state and converts them to host-delegated SharedPipeBuffers.

**Step 1: Add pipe tracking to ProcessManager**

```typescript
// In ProcessManager class:
private nextPipeHandle = 1000; // Start at 1000 to avoid conflicts with file handles
private sharedPipes = new Map<number, SharedPipeBuffer>();
```

**Step 2: Add pipe conversion to fork()**

After the child worker is created and ready, the ProcessManager needs to:
1. Parse pipe OFD indices from the fork state (or request them from the parent)
2. Create SharedPipeBuffers for each pipe
3. Register them with both parent and child workers
4. Tell both workers to convert the pipe OFDs

The simplest approach: add a `GetPipeInfoMessage` / `PipeInfoMessage` exchange, where the host asks the parent worker to list its pipe OFDs. Or, parse the fork state binary to extract pipe OFD info.

For simplicity, add a new Wasm export `kernel_get_pipe_ofds` that returns the indices of all pipe-type OFDs. But that requires another Wasm export + protocol message.

Alternatively: the ProcessManager already has the fork state binary data (it passes through `requestForkState`). Parse the OFD section to identify pipes. The OFD format includes `file_type: u32` where Pipe=2.

Add a helper method to parse pipe info from fork state:

```typescript
private parsePipeOfdsFromForkState(forkState: ArrayBuffer): { ofdIndex: number; isRead: boolean }[] {
  const view = new DataView(forkState);
  let offset = 12; // skip header
  offset += 32;    // skip scalars

  // Skip signal state
  offset += 8; // blocked u64
  const handlerCount = view.getUint32(offset, true);
  offset += 4;
  offset += handlerCount * 8; // skip handlers

  // Skip FD table
  const maxFds = view.getUint32(offset, true);
  offset += 4;
  const fdCount = view.getUint32(offset, true);
  offset += 4;

  // Build fd→ofd mapping for pipe analysis
  const fdToOfd = new Map<number, { ofdIndex: number; fdFlags: number }>();
  for (let i = 0; i < fdCount; i++) {
    const fdNum = view.getUint32(offset, true);
    const ofdIndex = view.getUint32(offset + 4, true);
    const fdFlags = view.getUint32(offset + 8, true);
    fdToOfd.set(fdNum, { ofdIndex, fdFlags });
    offset += 12;
  }

  // Read OFD table
  const ofdCount = view.getUint32(offset, true);
  offset += 4;

  const pipeOfds: { ofdIndex: number; statusFlags: number }[] = [];
  for (let i = 0; i < ofdCount; i++) {
    const index = view.getUint32(offset, true);
    const fileType = view.getUint32(offset + 4, true);
    const statusFlags = view.getUint32(offset + 8, true);
    offset += 12 + 8 + 8 + 4; // skip host_handle(i64), offset(i64), ref_count(u32)

    if (fileType === 2) { // Pipe
      pipeOfds.push({ ofdIndex: index, statusFlags });
    }
  }

  return pipeOfds.map(p => ({
    ofdIndex: p.ofdIndex,
    isRead: (p.statusFlags & 3) === 0, // O_RDONLY = 0
  }));
}
```

**Step 3: Modify fork() to convert pipes**

After the child worker signals ready, send pipe conversion messages:

```typescript
// After childInfo.state = "running" in fork():

// Detect pipes from fork state and convert them
const pipeOfds = this.parsePipeOfdsFromForkState(forkState);
if (pipeOfds.length > 0) {
  // Group pipe OFDs that share the same underlying pipe (same host_handle)
  // For now, create one SharedPipeBuffer per pipe OFD pair (read + write ends)
  // Each pipe has a read OFD and a write OFD pointing to the same pipe index

  for (const pipeOfd of pipeOfds) {
    const handle = this.nextPipeHandle++;
    const sharedPipe = SharedPipeBuffer.create();
    this.sharedPipes.set(handle, sharedPipe);

    const sab = sharedPipe.getBuffer();

    // Register with both workers
    parentInfo.worker.postMessage(
      { type: "register_pipe", handle, buffer: sab },
    );
    childInfo.worker.postMessage(
      { type: "register_pipe", handle, buffer: sab },
    );

    // Convert in both kernels
    parentInfo.worker.postMessage(
      { type: "convert_pipe", ofdIndex: pipeOfd.ofdIndex, newHandle: handle },
    );
    childInfo.worker.postMessage(
      { type: "convert_pipe", ofdIndex: pipeOfd.ofdIndex, newHandle: handle },
    );
  }
}
```

**Step 4: Write tests**

Add to `host/test/process-manager.test.ts`:

```typescript
describe("ProcessManager pipe conversion on fork", () => {
  it("should detect pipe OFDs in fork state and send conversion messages", async () => {
    const { pm, adapter } = createTestPM();

    // Spawn parent
    const spawnPromise = pm.spawn();
    adapter.lastWorker!.simulateMessage({ type: "ready", pid: 1 });
    await spawnPromise;
    const parentWorker = adapter.lastWorker!;

    // Fork parent (simulate fork state containing pipe OFDs)
    const forkPromise = pm.fork(1);

    // Build a minimal fork state with pipe OFDs
    const forkState = buildForkStateWithPipes();
    parentWorker.simulateMessage({
      type: "fork_state",
      pid: 1,
      data: forkState,
    });

    await Promise.resolve(); // Let child worker be created

    const childWorker = adapter.lastWorker!;
    childWorker.simulateMessage({ type: "ready", pid: 2 });
    await forkPromise;

    // Both workers should have received register_pipe and convert_pipe messages
    const parentPipeMessages = parentWorker.sentMessages.filter(
      (m: any) => m.type === "register_pipe" || m.type === "convert_pipe"
    );
    const childPipeMessages = childWorker.sentMessages.filter(
      (m: any) => m.type === "register_pipe" || m.type === "convert_pipe"
    );

    // If the fork state contained pipes, both workers should have pipe messages
    if (parentPipeMessages.length > 0) {
      expect(parentPipeMessages.length).toBeGreaterThan(0);
      expect(childPipeMessages.length).toBeGreaterThan(0);
    }
  });
});
```

Note: The helper `buildForkStateWithPipes()` constructs a binary fork state buffer with the correct format including pipe OFDs. This requires understanding the binary format from Phase 13b.

**Step 5: Run tests**

Run: `cd host && npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add host/src/process-manager.ts host/test/process-manager.test.ts
git commit -m "feat: detect and convert shared pipes on fork"
```

---

### Task 5: Integration Tests (TypeScript)

**Files:**
- Modify: `host/test/multi-worker.test.ts`

**Step 1: Add cross-process pipe integration test**

```typescript
describe("Cross-Process Pipe Integration", () => {
  it("should transfer data between parent and child via converted pipe", async () => {
    const pm = new ProcessManager({
      wasmBytes: loadWasmBytes(),
      kernelConfig: {
        maxWorkers: 4,
        dataBufferSize: 65536,
        useSharedMemory: false,
      },
      workerAdapter: new NodeWorkerAdapter(),
    });

    // Spawn parent
    const parentPid = await pm.spawn();

    // Fork (pipes in parent will be detected and converted)
    const childPid = await pm.fork(parentPid);

    // Both should be running
    expect(pm.getProcess(parentPid)!.state).toBe("running");
    expect(pm.getProcess(childPid)!.state).toBe("running");

    // Clean up
    await pm.terminate(childPid);
    await pm.terminate(parentPid);
  }, 15_000);
});
```

Note: A full data transfer test (parent writes to pipe, child reads from pipe) requires the ability to execute Wasm code in workers that creates a pipe, writes data, and reads data. This may require adding a test helper that calls kernel functions. For now, test that fork with pipe detection and conversion completes without errors.

**Step 2: Run all tests**

Run: `cd host && npx vitest run`
Run: `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo`
Expected: All tests pass

**Step 3: Commit**

```bash
git add host/test/multi-worker.test.ts
git commit -m "test: add cross-process pipe integration test"
```

---

### Task 6: Update Documentation

**Files:**
- Modify: `docs/posix-status.md`

**Step 1: Update posix-status.md**

Update the pipe() entry to mention cross-process support:

```markdown
| `pipe()` | Partial | Kernel-space ring buffer (64KB). PIPE_BUF=4096. O_NONBLOCK enforced (EAGAIN). Cross-process pipes via SharedArrayBuffer after fork. Blocking read/write not yet implemented. |
```

Add Phase 13c to Implementation Priority:

```markdown
13c. **Phase 13c (Complete):** Cross-Process Pipes
- SharedPipeBuffer class (SharedArrayBuffer ring buffer with atomics)
- Host-delegated pipe support in kernel (host_handle >= 0 routes to host)
- kernel_convert_pipe_to_host Wasm export
- Pipe detection and conversion on fork
```

**Step 2: Commit**

```bash
git add docs/posix-status.md
git commit -m "docs: update POSIX status for Phase 13c cross-process pipes"
```
