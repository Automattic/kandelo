# Browser Support

## Overview

The wasm-posix-kernel runs in modern browsers with SharedArrayBuffer support (Chrome 91+, Firefox 79+, Safari 16.4+). Single-process programs work on the main thread. Multi-process coordination is available via Web Workers.

## Required HTTP Headers

SharedArrayBuffer requires cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, `SharedArrayBuffer` is undefined and the kernel cannot initialize.

## Entry Points

```javascript
// Auto-resolved by bundlers with "browser" condition (vite, webpack):
import { WasmPosixKernel, ProgramRunner, ... } from "wasm-posix-host";

// Explicit browser import:
import { WasmPosixKernel, ProgramRunner, ... } from "wasm-posix-host/browser";

// Worker entry (auto-resolved for browser):
import "wasm-posix-host/worker-entry";

// Explicit browser worker entry:
import "wasm-posix-host/worker-entry-browser";
```

## Browser API

Available from `wasm-posix-host/browser`:

| Export | Purpose |
|--------|---------|
| `WasmPosixKernel` | Core kernel loader |
| `ProgramRunner` | Run user programs against the kernel |
| `VirtualPlatformIO` | Mount-based virtual filesystem |
| `MemoryFileSystem` | In-memory filesystem backend |
| `BrowserTimeProvider` | Browser-compatible time (performance.now) |
| `ProcessManager` | Multi-process management via Web Workers |
| `BrowserWorkerAdapter` | Web Worker creation adapter |
| `SyscallChannel` | Shared memory syscall channel |
| `SharedPipeBuffer` | Inter-process pipe via SharedArrayBuffer |

## Single-Process Usage (Main Thread)

```typescript
import { WasmPosixKernel, ProgramRunner } from "wasm-posix-host/browser";
import { VirtualPlatformIO } from "wasm-posix-host/browser";
import { MemoryFileSystem } from "wasm-posix-host/browser";
import { BrowserTimeProvider } from "wasm-posix-host/browser";

// 1. Create virtual filesystem
const memfs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
const io = new VirtualPlatformIO(
  [{ mountPoint: "/", backend: memfs }],
  new BrowserTimeProvider(),
);
memfs.mkdir("/tmp", 0o777);

// 2. Create kernel
const kernel = new WasmPosixKernel(
  { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
  io,
  {
    onStdout: (data) => console.log(new TextDecoder().decode(data)),
    onStderr: (data) => console.error(new TextDecoder().decode(data)),
  },
);
await kernel.init(kernelWasmBytes);

// 3. Run program
const runner = new ProgramRunner(kernel);
const exitCode = await runner.run(programWasmBytes);
```

## Known Limitations

### No fork() from user-space Wasm

The `fork()` C library call is not available from within Wasm programs. Multi-process must be orchestrated from the host (JavaScript) side using `ProcessManager.spawn()` and `ProcessManager.fork()`.

This is a fundamental design constraint: WebAssembly cannot create threads or workers directly.

### nanosleep() blocks the calling thread

`nanosleep()` uses `Atomics.wait()` which blocks the calling thread. On the main thread, this freezes the UI. In a Web Worker, it blocks that worker. Programs that sleep will work correctly but will be unresponsive during the sleep.

### Memory-only filesystem

Browser workers cannot access the host filesystem. Only `MemoryFileSystem` is available. Programs that need files must have them pre-created in the memory filesystem before execution.

### File permission stubs

`MemoryFileSystem` does not enforce POSIX permissions. `chmod()`, `chown()`, and `access()` are no-ops or always succeed. Files are readable/writable by all.

### Program loading for exec()

When user-space code calls `execve()`, the host receives the path but must provide the Wasm binary. There is no built-in mechanism to map filesystem paths to Wasm binaries. The current `ProcessManager` reloads the same kernel binary on exec.

### No host filesystem access

`HostFileSystem` and `NodePlatformIO` are not available in browser builds. All filesystem operations go through `VirtualPlatformIO` with `MemoryFileSystem` backends.

## Vite Configuration

For local development with Vite:

```typescript
// vite.config.ts
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      allow: [path.resolve(__dirname, "../..")], // allow serving wasm files
    },
  },
};
```
