# Porting Guide

This guide covers how to port C/C++ software to Kandelo, create Node.js runners, and build browser demos.

## Overview

The general workflow is:

1. Cross-compile the software using the SDK (see [SDK Guide](sdk-guide.md))
2. Create a runner script (Node.js or browser) that loads the kernel and program
3. Handle any platform-specific needs (filesystem setup, fork/exec support, networking)

## Porting C Software

### Step 1: Cross-compile

Most C projects use autoconf, CMake, or plain Makefiles. The SDK handles all three.

**Autoconf projects** (dash, grep, sed, coreutils):
```bash
wasm32posix-configure [--enable-static] [other flags]
make
```

**CMake projects** (MariaDB, PCRE2):
```bash
cmake -B build -DCMAKE_TOOLCHAIN_FILE=wasm32-posix-toolchain.cmake [flags]
cmake --build build
```

**Makefile projects** (Redis, SQLite):
```bash
make CC=wasm32posix-cc AR=wasm32posix-ar RANLIB=wasm32posix-ranlib [flags]
```

### Step 2: Handle common issues

**Missing features**: Check [wasm-limitations.md](wasm-limitations.md) for what cannot be implemented (mprotect, raw server sockets in browser, guest-initiated pthread_create). Most software has graceful fallbacks for these.

**fork() support**: If the program uses `fork()`, `posix_spawn()`, or `system()`, apply Asyncify post-processing:
```bash
wasm-opt --asyncify \
  --asyncify-imports "env.channel_syscall" \
  --pass-arg=asyncify-ignore-indirect \
  -O2 program.wasm -o program.wasm
```

For large programs, use `--asyncify-onlylist` to limit instrumentation to functions reachable from `fork()`. See `examples/libs/php/build-php.sh` for an example.

**Thread support**: Programs that create threads (MariaDB, Redis) work via the kernel's `clone()` syscall. No special compilation flags needed, but the host runner must implement the `onClone` callback.

**C++ and libc++**: For C++ programs, include libc++ headers from your LLVM installation. Set `_LIBCPP_HAS_MUSL_LIBC=1` and `_LIBCPP_HAS_THREAD_API_PTHREAD=1` in a `__config_site` header. See `examples/libs/mariadb/build-mariadb.sh` for a complete example.

### Step 3: Test it

```bash
npx tsx examples/run-example.ts /path/to/program.wasm [args]
```

## Shipping runtime files: the lazy-archive pattern

Many ported programs depend on a tree of read-only runtime files at execution time — vim's syntax and indent scripts, NetHack's `nhdat`, Python's stdlib, ncurses terminfo, and so on. **Use the lazy-archive pattern to deliver them.** It is the canonical approach for the browser shell demo and any other browser page that needs on-demand runtime files.

Two alternatives exist and should be avoided unless you have a specific reason:

- **Baking files directly into the VFS image** inflates the demo's initial download even when the program is never launched.
- **Per-file lazy registration** (`registerLazyFile`) works for a binary or two but scales badly to thousands of small files because each file issues its own HTTP request on first access.

### When to use it

Any time a ported program needs more than a handful of runtime files that together exceed a few hundred KB. The binary itself can (and usually should) go into the same archive — vim's `vim.zip` contains both the wasm binary and the runtime tree.

### How it works

`MemoryFileSystem.registerLazyArchiveFromEntries(url, zipEntries, mountPrefix)` walks the central directory of a zip, creates inode stubs for every file under `mountPrefix`, and remembers the archive URL. On first access to any stub in the group, the worker fetches the full zip, materializes every entry into memory, and future reads are served from memory. Materialization happens once per VFS instance.

At runtime the URL stored in the group is bare — a plain filename like `vim.zip`. The browser runtime calls `memfs.rewriteLazyArchiveUrls(url => BASE_URL + url)` once, right after `MemoryFileSystem.fromImage`, so the archive resolves against the deployment's base URL instead of the build-time one.

### Build-side contract

A porter producing a lazy-archive-backed program creates three things:

1. **`examples/libs/<program>/build-<program>.sh`** — cross-compiles the wasm binary into `examples/libs/<program>/bin/<program>.wasm`.
2. **`examples/libs/<program>/bundle-runtime.sh`** (only if the source tree already has runtime files that need trimming) — copies the minimal runtime tree into `examples/libs/<program>/runtime/`.
3. **`examples/browser/scripts/build-<program>-zip.sh`** — stages `bin/<program>` and `share/<program>/…` into `examples/browser/public/<program>.zip`. Paths inside the archive are relative (e.g. `bin/vim`, `share/vim/vim91/syntax/c.vim`), and the mount prefix chosen at registration time (usually `/usr/`) turns them into absolute VFS paths.

Programs whose runtime files are small enough to version in-tree (NetHack's `nhdat` after DLB packing, for instance) can skip step 2 and have the zip script pull directly from the build's `out/` directory.

### Registration

`examples/browser/scripts/build-shell-vfs-image.ts` is the reference example:

```typescript
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";

function populateVimArchive(fs: MemoryFileSystem): number {
  const zipBytes = readFileSync("examples/browser/public/vim.zip");
  const entries = parseZipCentralDirectory(new Uint8Array(zipBytes));
  const group = fs.registerLazyArchiveFromEntries("vim.zip", entries, "/usr/");
  return group.entries.size;
}
```

The call creates `/usr/bin/vim` and `/usr/share/vim/vim91/...` as stubs inside the shell VFS. The demo's `main.ts` does **not** need a matching `registerLazyFiles` entry for the binary — the stub from the archive is enough.

### When you also want `/bin/<program>` symlinks

Create them in the VFS image builder (see `populateExtendedSymlinks` in `build-shell-vfs-image.ts`) — not inside the archive. Symlinks are a VFS concern, not a packaging concern.

### Reference implementation

Vim:

- `examples/libs/vim/build-vim.sh` — cross build.
- `examples/libs/vim/bundle-runtime.sh` — minimal runtime tree.
- `examples/browser/scripts/build-vim-zip.sh` — stage + zip.
- `examples/browser/scripts/build-shell-vfs-image.ts` — `populateVimArchive()`.
- `examples/browser/pages/shell/main.ts` — `memfs.rewriteLazyArchiveUrls(url => BASE_URL + url)`.

Follow the same layout for new ports; reviewers will expect it.

## Creating a Node.js Runner

The simplest way to run a Wasm program is with `examples/run-example.ts`. For custom runners, use `CentralizedKernelWorker` directly.

### Minimal runner

```typescript
import { readFileSync } from "fs";
import { CentralizedKernelWorker } from "../host/src/kernel-worker";
import { NodePlatformIO } from "../host/src/platform/node";
import { NodeWorkerAdapter } from "../host/src/worker-adapter";

const CH_TOTAL_SIZE = 40 + 65536;
const MAX_PAGES = 16384;

const kernelBytes = readFileSync("host/wasm/wasm_posix_kernel.wasm");
const programBytes = readFileSync("program.wasm");

const io = new NodePlatformIO();
const workerAdapter = new NodeWorkerAdapter();

const kernelWorker = new CentralizedKernelWorker(
  { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
  io,
  {
    onFork: async (parentPid, childPid, parentMemory) => {
      // Copy parent memory, register child, spawn child worker
      // See examples/run-example.ts for full implementation
    },
    onExec: async (pid, path, argv, envp) => {
      // Resolve path to wasm binary, replace process
      // Return 0 on success, -2 (ENOENT) if not found
    },
    onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
      // Allocate thread channel, spawn thread worker
      // Return tid on success
    },
    onExit: (pid, status) => {
      // Handle process exit
    },
  },
);

// Initialize kernel
await kernelWorker.init(kernelBytes.buffer);

// Create shared memory
const memory = new WebAssembly.Memory({
  initial: 17, maximum: MAX_PAGES, shared: true,
});
memory.grow(MAX_PAGES - 17);

// Place channel at end of address space
const channelOffset = (MAX_PAGES - 2) * 65536;
new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

// Register and spawn process
const pid = 100;
kernelWorker.registerProcess(pid, memory, [channelOffset]);
```

For a complete example with fork/exec/clone support, see `examples/run-example.ts`.

### Key API: CentralizedKernelWorker

```typescript
// Initialize with kernel wasm bytes
await kernelWorker.init(kernelWasmBytes: ArrayBuffer)

// Register a process
kernelWorker.registerProcess(pid, memory, channelOffsets, options?)

// Set process working directory
kernelWorker.setCwd(pid, path)

// Set next PID for child processes
kernelWorker.setNextChildPid(pid)

// Provide stdin data
kernelWorker.setStdinData(pid, data: Uint8Array)
kernelWorker.appendStdinData(pid, data: Uint8Array)

// Unregister (after exit)
kernelWorker.unregisterProcess(pid)

// For zombies (keep in kernel until reaped)
kernelWorker.deactivateProcess(pid)
```

## Creating Browser Demos

Browser demos use `BrowserKernel` which handles the kernel worker, process lifecycle, and filesystem in a browser-friendly API.

### Project setup

Browser demos live in `examples/browser/pages/<name>/`. Each page has:

```
pages/<name>/
  index.html    # Page HTML
  main.ts       # Page logic (TypeScript, bundled by Vite)
```

Register the page in `examples/browser/vite.config.ts`:

```typescript
build: {
  rollupOptions: {
    input: {
      // ... existing pages
      "my-demo": path.resolve(__dirname, "pages/my-demo/index.html"),
    },
  },
},
```

Add a nav link in each `index.html` (or use the existing nav bar pattern).

### Minimal browser demo

**index.html**:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Demo</title>
  <style>
    #output {
      background: #1e1e1e; color: #d4d4d4; padding: 1rem;
      white-space: pre-wrap; min-height: 200px; font-size: 0.85rem;
    }
    .stderr { color: #f48771; }
  </style>
</head>
<body>
  <h1>My Demo</h1>
  <button id="run">Run</button>
  <pre id="output"></pre>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

**main.ts**:
```typescript
import { BrowserKernel } from "../../lib/browser-kernel";
import myProgramUrl from "../../../../path/to/program.wasm?url";

const output = document.getElementById("output") as HTMLPreElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const decoder = new TextDecoder();

function appendOutput(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  output.appendChild(span);
}

runBtn.addEventListener("click", async () => {
  runBtn.disabled = true;
  output.textContent = "";

  const programBytes = await fetch(myProgramUrl).then(r => r.arrayBuffer());

  const kernel = new BrowserKernel({
    onStdout: (data) => appendOutput(decoder.decode(data)),
    onStderr: (data) => appendOutput(decoder.decode(data), "stderr"),
  });

  await kernel.init(); // fetches kernel wasm automatically

  const exitCode = await kernel.spawn(programBytes, ["my-program", "--arg"]);
  appendOutput(`\nExited with code ${exitCode}\n`);
  runBtn.disabled = false;
});
```

### BrowserKernel API

```typescript
const kernel = new BrowserKernel({
  maxWorkers?: number,         // Max concurrent workers (default: 4)
  fsSize?: number,             // MemoryFileSystem size in bytes (default: 16MB)
  maxMemoryPages?: number,     // Wasm pages per process (default: 16384 = 1GB)
  env?: string[],              // Environment variables
  onStdout?: (data: Uint8Array) => void,
  onStderr?: (data: Uint8Array) => void,
  onListenTcp?: (pid, fd, port) => void,  // Called when process binds a port
  threadModule?: WebAssembly.Module,       // Pre-compiled module for threads
});

// Initialize (fetches kernel wasm if not provided)
await kernel.init(kernelWasmBytes?: ArrayBuffer)

// Access filesystem for pre-populating files
kernel.fs.mkdir("/data", 0o755)
kernel.fs.open("/data/config.txt", 0x241, 0o644)  // O_WRONLY|O_CREAT|O_TRUNC
kernel.fs.write(fd, data, data.length, -1)
kernel.fs.close(fd)

// Spawn a process
const exitCode = await kernel.spawn(programBytes, argv, {
  env?: string[],
  cwd?: string,
  stdin?: Uint8Array,     // Complete stdin data (EOF after consumed)
  pty?: boolean,          // Allocate a PTY for this process
})

// Stdin operations
kernel.setStdinData(pid, data)       // Set complete stdin (implies EOF)
kernel.appendStdinData(pid, data)    // Append to stdin buffer (interactive)

// PTY operations (for terminal demos)
kernel.ptyWrite(pid, data)           // Write to PTY master
kernel.ptyResize(pid, rows, cols)    // Resize PTY
kernel.onPtyOutput(pid, callback)    // Receive PTY output

// TCP connection injection (for HTTP bridge demos)
await kernel.injectConnection(pid, listenerFd, peerAddr, peerPort)

// Pipe operations (for app-level clients like MySQL, Redis)
await kernel.pipeWrite(pid, pipeIdx, data)
await kernel.pipeRead(pid, pipeIdx)
kernel.pipeCloseWrite(pid, pipeIdx)
kernel.pipeCloseRead(pid, pipeIdx)

// Service worker bridge
kernel.sendBridgePort(hostPort, httpPort)

// Cleanup
await kernel.destroy()
```

### Filesystem pre-population

The kernel reads files from the shared `MemoryFileSystem`. For demos with many files, use a **VFS image** — a pre-built binary snapshot of the filesystem:

```typescript
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { BrowserKernel } from "../../lib/browser-kernel";

// Fetch kernel wasm and VFS image in parallel
const [kernelBuf, vfsImageBuf] = await Promise.all([
  fetch(kernelUrl).then(r => r.arrayBuffer()),
  fetch(vfsImageUrl).then(r => r.arrayBuffer()),
]);

// Restore filesystem from image (single buffer copy — fast)
const memfs = MemoryFileSystem.fromImage(
  new Uint8Array(vfsImageBuf),
  { maxByteLength: 512 * 1024 * 1024 },  // allow growth
);

// Create kernel with pre-populated filesystem
const kernel = await BrowserKernel.create({ kernelWasm: kernelBuf, memfs });
```

See [docs/browser-support.md](browser-support.md#vfs-images) for how to create VFS image build scripts.

For simple demos with few files, you can also write files directly:

```typescript
const kernel = new BrowserKernel({ fsSize: 32 * 1024 * 1024 }); // 32MB
await kernel.init();

// Write a config file
const config = new TextEncoder().encode("key=value\n");
const fd = kernel.fs.open("/etc/my.conf", 0x241, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
kernel.fs.write(fd, config, config.length, -1);
kernel.fs.close(fd);

// Load a wasm binary into the filesystem (for exec)
const dashBytes = await fetch(dashWasmUrl).then(r => r.arrayBuffer());
const binFd = kernel.fs.open("/bin/sh", 0x241, 0o755);
kernel.fs.write(binFd, new Uint8Array(dashBytes), dashBytes.byteLength, -1);
kernel.fs.close(binFd);

// Create symlinks for multicall binaries
kernel.fs.symlink("/bin/coreutils", "/bin/ls");
kernel.fs.symlink("/bin/coreutils", "/bin/cat");
```

### HTTP bridge demos (nginx, WordPress)

For demos that serve HTTP (nginx, PHP-FPM, WordPress), a service worker intercepts browser requests and routes them to the kernel:

```typescript
import { HttpBridgeHost } from "../../lib/http-bridge";

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const bridge = new HttpBridgeHost();

// Register service worker and init bridge
await navigator.serviceWorker.register(import.meta.env.BASE_URL + "service-worker.js");
const reg = await navigator.serviceWorker.ready;
const reply = new MessageChannel();
await new Promise<void>((resolve) => {
  reply.port1.onmessage = () => resolve();
  reg.active!.postMessage(
    { type: "init-bridge", appPrefix: APP_PREFIX },
    [bridge.getSwPort(), reply.port2],
  );
});

// Connect bridge to kernel
kernel.sendBridgePort(bridge.detachHostPort(), 8080);

// When nginx starts listening, load iframe
kernel.options.onListenTcp = (pid, fd, port) => {
  document.getElementById("frame").src = APP_PREFIX;
};
```

The service worker (`public/service-worker.js`) handles:
- Adding COOP/COEP headers for cross-origin isolation
- Routing requests matching `appPrefix` to the kernel via MessagePort
- Cookie jar for session persistence (WordPress)

### Thread support in browser demos

For programs that create threads (MariaDB, Redis), pre-compile the thread module on the main thread to get optimized code:

```typescript
import { patchWasmForThread } from "../../../../host/src/worker-main";

const programBytes = await fetch(programUrl).then(r => r.arrayBuffer());
const threadPatchedBytes = patchWasmForThread(programBytes);
const threadModule = await WebAssembly.compile(threadPatchedBytes);

const kernel = new BrowserKernel({
  maxWorkers: 8,
  threadModule,
  // ...
});
```

### Interactive terminal demos

For shell or REPL demos, use `PtyTerminal` with xterm.js:

```typescript
import { PtyTerminal } from "../../lib/pty-terminal";
import "xterm/css/xterm.css";

const kernel = new BrowserKernel({ /* ... */ });
await kernel.init();

const terminal = new PtyTerminal(kernel);
terminal.mount(document.getElementById("terminal"));

// Spawn with PTY
const exitCode = await kernel.spawn(programBytes, ["sh"], { pty: true });
```

## Demo Patterns

### Pattern: Simple program runner

Fetch wasm, spawn, display output. See `examples/browser/main.ts`.

### Pattern: Server with HTTP bridge

nginx, PHP-FPM, WordPress. Service worker intercepts requests, connection pump bridges to kernel. See `examples/browser/pages/nginx/main.ts`.

### Pattern: Database with wire protocol client

MariaDB, Redis. Kernel spawns server process, main-thread client connects via pipe operations. See `examples/browser/pages/redis/main.ts`, `lib/redis-client.ts`, `lib/mysql-client.ts`.

### Pattern: Interactive shell/REPL

PTY allocation, xterm.js terminal, incremental stdin. See `examples/browser/pages/shell/main.ts`, `examples/browser/pages/python/main.ts`.

### Pattern: Full stack (LAMP)

Multiple processes (MariaDB + nginx + PHP-FPM + WordPress), database bootstrap, filesystem pre-population, HTTP bridge. See `examples/browser/pages/lamp/main.ts`.

## Existing Build Scripts

All build scripts are in `examples/libs/`. They serve as reference implementations:

| Software | Script | Build system | Notes |
|----------|--------|-------------|-------|
| dash | `libs/dash/build-dash.sh` | autoconf | Minimal POSIX shell |
| coreutils | `libs/coreutils/build-coreutils.sh` | autoconf | 50+ utilities as multicall binary |
| grep | `libs/grep/build-grep.sh` | autoconf | PCRE not included |
| sed | `libs/sed/build-sed.sh` | autoconf | Straightforward |
| PHP | `libs/php/build-php.sh` | autoconf | CLI + FPM, depends on zlib/libxml2/sqlite/openssl |
| MariaDB | `libs/mariadb/build-mariadb.sh` | CMake | Host build + cross build, Aria storage engine only |
| Redis | `libs/redis/build-redis.sh` | Makefile | Custom make invocation |
| CPython | `libs/cpython/build-cpython.sh` | autoconf | Host build for `_freeze_module`, then cross build |
| nginx | `examples/nginx/` | custom configure | Shell-based configure script |
| SQLite | `libs/sqlite/build-sqlite.sh` | custom | Single-file amalgamation |
| zlib | `libs/zlib/build-zlib.sh` | custom configure | Dependency for PHP |
| libxml2 | `libs/libxml2/build-libxml2.sh` | CMake | Dependency for PHP |
| OpenSSL | `libs/openssl/build-openssl.sh` | custom Configure | Dependency for PHP |

## Troubleshooting

**"sysroot not found"**: Run `bash scripts/build-musl.sh` first.

**"wasm_posix_kernel.wasm not found"**: Run `bash build.sh` first.

**Fork fails silently**: Apply Asyncify post-processing to the program binary.

**"Maximum call stack size exceeded" in browser**: The program has too many Asyncify-instrumented functions. Use `--asyncify-onlylist` to restrict to only the fork path.

**Process hangs on read**: The fd might be in blocking mode waiting for data. Check that writers are properly closing their end of the pipe.

**Browser SharedArrayBuffer unavailable**: Ensure COOP/COEP headers are set. In production, the service worker handles this. In dev, Vite's config sets them.
