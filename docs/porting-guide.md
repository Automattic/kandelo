# Porting Guide

This guide covers how to port C/C++ software to Kandelo, create Node.js runners, and prepare browser-facing package images.

## Overview

The general workflow is:

1. Cross-compile the software using the SDK (see [SDK Guide](sdk-guide.md))
2. Create a runner script or package image that loads the kernel and program
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

**fork() support**: If the program uses `fork()` or fork-like behavior, run
`wasm-fork-instrument` as the final step of the wasm pipeline (after any
`wasm-opt -O2`). Fork-like behavior includes `vfork()`, `_Fork()`, shell
pipelines, command substitution, `system()`, `popen()`, and helper processes
implemented through fork.
```bash
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" program.wasm -o program.wasm
```

The tool auto-discovers the fork-call closure via call-graph analysis (direct + indirect calls). No onlylist file is needed, and no manual tracing of fork paths. It must run last — it hardcodes mutable-global offsets at instrument time, and any later pass that reorders globals will corrupt the fork save buffer.

Instrumentation is mandatory for fork-using programs. Do not treat it as an
optional optimization, and do not use Binaryen Asyncify as a fallback. The host
requires complete `wpk_fork_*` exports for fork continuation and rejects legacy
`asyncify_*` artifacts. See [fork-instrumentation.md](fork-instrumentation.md)
for the full transform and ABI.

**Thread support**: Programs that create threads (MariaDB, Redis) work via the kernel's `clone()` syscall. No special compilation flags needed, but the host runner must implement the `onClone` callback.

**C++ and libc++**: For C++ programs, depend on the `libcxx` package and
compile against its resolved headers and libraries, normally symlinked into
the Kandelo sysroot by the consuming package build script. Do not copy libc++
headers from an arbitrary host LLVM install; the libcxx package generates and
ships a version-matched header tree with its `libc++.a` and `libc++abi.a`.
See `packages/registry/mariadb/build-mariadb.sh` for a complete example.

### OSS playback with `/dev/dsp`

Kandelo's standard low-level audio API is OSS `/dev/dsp`, backed by the generic
PCM stream core. Do not enable ALSA or copy Linux `/dev/snd` headers into a
port. Direct users include `<sys/soundcard.h>`, open `/dev/dsp` with
`O_WRONLY`, negotiate an advertised format/rate/channel count, and use
blocking `write()` or `poll(POLLOUT)` plus nonblocking writes. See the exact
[ioctl matrix](posix-status.md#oss-playback-compatibility).
Writes are a continuous byte stream, so an application may split a PCM frame
across calls. `SNDCTL_DSP_SYNC` and final close pad a terminal partial frame
with format silence and wait for it to reach the audio clock.

Upstream SDL needs no DSP-backend source changes. The registry packages build
the official releases with only their OSS audio backend:

```bash
cargo xtask build-deps resolve sdl2
cargo xtask build-deps resolve sdl3
```

For an external SDL2 build, retain the equivalent of:

```bash
./configure --host=wasm32-unknown-none \
  --enable-static --disable-shared \
  --enable-audio --enable-oss \
  --disable-alsa --disable-pulseaudio --disable-pipewire \
  --disable-jack --disable-sndio
```

SDL2 2.32.x does not classify `wasm32-unknown-none` as a Unix target upstream,
so the Kandelo package carries a minimal platform-classification patch to its
generated configure logic. It does not change `src/audio/dsp/`.

For SDL3, configure a truthful Kandelo CMake toolchain and retain:

```bash
cmake -S SDL -B build \
  -DCMAKE_TOOLCHAIN_FILE=/path/to/kandelo-toolchain.cmake \
  -DSDL_STATIC=ON -DSDL_SHARED=OFF \
  -DSDL_UNIX_CONSOLE_BUILD=ON \
  -DSDL_AUDIO=ON -DSDL_OSS=ON \
  -DSDL_ALSA=OFF -DSDL_PULSEAUDIO=OFF -DSDL_PIPEWIRE=OFF \
  -DSDL_JACK=OFF -DSDL_SNDIO=OFF
```

The registry's SDL3 patch only teaches its platform detector that Kandelo is
Unix; its OSS backend is also unmodified. Do not claim Linux or Emscripten as
the target to make feature detection pass.

At runtime the default path is already `/dev/dsp`. Set
`SDL_AUDIODRIVER=dsp` when a deterministic backend choice is needed (tests,
headless runners, or images that may gain another driver later). SDL also
honors its upstream device-path overrides (`AUDIODEV`, and `SDL_PATH_DSP` in
SDL2). Playback supports U8/S16_LE/S16_BE, mono/stereo, and 8–192 kHz. SDL2's
backend is paced primarily by blocking `write()`; SDL3 additionally waits on
truthful `SNDCTL_DSP_GETOSPACE` results. Capture/duplex opens fail with
`ENOTSUP`, so do not advertise recording support in application UI.

### Step 3: Test it

```bash
npx tsx examples/run-example.ts /path/to/program.wasm [args]
```

## Shipping runtime files: the lazy-archive pattern

Many ported programs depend on a tree of read-only runtime files at execution time - vim's syntax and indent scripts, NetHack's `nhdat`, Python's stdlib, ncurses terminfo, and so on. **Use the lazy-archive pattern to deliver them.** It is the canonical approach for Kandelo browser UI images and retained browser labs that need on-demand runtime files.

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

1. **`packages/registry/<program>/build-<program>.sh`** — cross-compiles the wasm binary into `packages/registry/<program>/bin/<program>.wasm`.
2. **`packages/registry/<program>/bundle-runtime.sh`** (only if the source tree already has runtime files that need trimming) — copies the minimal runtime tree into `packages/registry/<program>/runtime/`.
3. **`images/vfs/scripts/build-<program>-zip.sh`** — stages `bin/<program>` and `share/<program>/…` into `apps/browser-demos/public/<program>.zip`. Paths inside the archive are relative (e.g. `bin/vim`, `share/vim/vim91/syntax/c.vim`), and the mount prefix chosen at registration time (usually `/usr/`) turns them into absolute VFS paths.

Programs whose runtime files are small enough to version in-tree (NetHack's `nhdat` after DLB packing, for instance) can skip step 2 and have the zip script pull directly from the build's `out/` directory.

### Registration

`images/vfs/scripts/build-shell-vfs-image.ts` is the reference example:

```typescript
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";

function populateVimArchive(fs: MemoryFileSystem): number {
  const zipBytes = readFileSync("apps/browser-demos/public/vim.zip");
  const entries = parseZipCentralDirectory(new Uint8Array(zipBytes));
  const group = fs.registerLazyArchiveFromEntries("vim.zip", entries, "/usr/");
  return group.entries.size;
}
```

The call creates `/usr/bin/vim` and `/usr/share/vim/vim91/...` as stubs inside the shell VFS. The Kandelo UI does **not** need a matching `registerLazyFiles` entry for the binary - the stub from the archive is enough.

### When you also want `/bin/<program>` symlinks

Create them in the VFS image builder (see `populateExtendedSymlinks` in `build-shell-vfs-image.ts`) — not inside the archive. Symlinks are a VFS concern, not a packaging concern.

### Reference implementation

Vim:

- `packages/registry/vim/build-vim.sh` — cross build.
- `packages/registry/vim/bundle-runtime.sh` — minimal runtime tree.
- `images/vfs/scripts/build-vim-zip.sh` — stage + zip.
- `images/vfs/scripts/build-shell-vfs-image.ts` — `populateVimArchive()`.
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` - rewrites lazy archive URLs when loading image-backed gallery entries.

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

const kernelBytes = readFileSync("host/wasm/kandelo-kernel.wasm");
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

## Browser UI Integration

The browser UI uses `BrowserKernel` from `host/src/browser-kernel-host.ts`, which handles the browser kernel worker, process lifecycle, and filesystem in a browser-friendly API. The product UI lives under `apps/browser-demos/pages/kandelo/`, retained browser labs live under `apps/browser-demos/pages/`, and the host runtime itself is maintained under `host/src/` beside the Node.js host.

### Lab page setup

Standalone browser lab pages, such as the Network lab, live in `apps/browser-demos/pages/<name>/`. Each page has:

```
pages/<name>/
  index.html    # Page HTML
  main.ts       # Page logic (TypeScript, bundled by Vite)
```

Register the page in `apps/browser-demos/vite.config.ts`:

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

Do not add standalone package demos here by default. New browser-facing software should normally be exposed through a Kandelo UI gallery preset or software manifest.

### Minimal browser lab

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
import { BrowserKernel } from "@host/browser-kernel-host";
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
  maxMemoryPages?: number,     // Max Wasm pages per process (default: 16384 = 1GB)
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
import { BrowserKernel } from "@host/browser-kernel-host";

// Fetch kernel wasm and VFS image in parallel
const [kernelBuf, vfsImageBuf] = await Promise.all([
  fetch(kernelUrl).then(r => r.arrayBuffer()),
  fetch(vfsImageUrl).then(r => r.arrayBuffer()),
]);

// Restore filesystem from image (single buffer copy — fast)
const memfs = MemoryFileSystem.fromImage(
  new Uint8Array(vfsImageBuf),
  { maxByteLength: 512 * 1024 * 1024 },  // allow growth up to the image's filesystem max
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

### Thread support in browser UI and labs

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

### Interactive terminal surfaces

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

## Browser UI Patterns

### Pattern: Simple program runner

Fetch wasm, spawn, display output. For the Kandelo UI, wire this through a gallery preset and `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`.

### Pattern: Server with HTTP bridge

nginx, PHP-FPM, WordPress. Service worker intercepts requests, connection pump bridges to kernel. See `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`.

### Pattern: Database with wire protocol client

MariaDB, Redis. Kernel spawns server process, main-thread client connects via pipe operations. See `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`, `apps/browser-demos/lib/redis-client.ts`, and `apps/browser-demos/lib/mysql-client.ts`.

### Pattern: Interactive shell/REPL

PTY allocation, xterm.js terminal, incremental stdin. See `apps/browser-demos/pages/kandelo/panes/Shell.tsx` and `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`.

### Pattern: Full stack (LAMP)

Multiple processes (MariaDB + nginx + PHP-FPM + WordPress), database bootstrap, filesystem pre-population, HTTP bridge. See `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`.

## Adding a new package to the registry

A "package" is anything under `packages/registry/<name>/` with a
`package.toml`. The same shape covers static libraries (zlib,
ncurses, openssl, ...), ported programs (vim, php, redis, ...),
composite VFS images (mariadb-vfs, wordpress, shell), and source-only
extracts that other builds reach into (pcre2-source). The resolver
treats all of them uniformly — declaring a package is what gives you
the cached-build + URL-addressable archive flow described in
[docs/package-management.md](package-management.md) and
[docs/binary-releases.md](binary-releases.md).

### 1. Scaffold the directory

```
packages/registry/<name>/
    package.toml        # required — recipe (project-agnostic)
    build.toml          # required (unless source-only) — project view + binary source
    build-<name>.sh     # required — produces the outputs
    bin/                # created by build script; never committed
```

### 2. Write `package.toml`

The **recipe** — project-agnostic identity, source pin, deps,
outputs. See `packages/registry/zlib/package.toml` (single library) and
`packages/registry/dinit/package.toml` (multi-output program with a
library dep) for canonical references; the schema reference is in
[docs/package-management.md §Schema](package-management.md#schema-packagetoml).

```toml
kind = "program"           # or "library" or "source"
name = "myprog"
version = "1.2.3"
kernel_abi = 39            # current ABI_VERSION; required for packages with a [build] block
depends_on = ["zlib@1.3.1"]   # transitive deps the resolver will pull first

[source]
url = "https://example.test/myprog-1.2.3.tar.gz"
sha256 = "<64-char lowercase hex>"

[license]
spdx = "GPL-2.0-or-later"
url = "https://example.test/LICENSE"

[build]
script_path = "packages/registry/myprog/build-myprog.sh"

# One [[outputs]] per produced file. Programs typically have 1 wasm;
# multi-output packages (dinit, mariadb, php) declare each separately.
# Layout: 1 output → flat under programs/<arch>/; ≥2 → nested under
# programs/<arch>/<name>/. Bash never hardcodes this; query via
# `xtask build-deps output-path` (or in run.sh use pkg_has_output).
[[outputs]]
name = "myprog"
wasm = "myprog.wasm"
```

`package.toml` MUST NOT carry `revision`, `[binary]`, `[build].repo_url`,
or `[build].commit` — those moved to `build.toml` during the
binary-resolution-via-index-ledger migration (see the
[design doc](plans/2026-05-13-binary-resolution-via-index-ledger-design.md)).
`validate_source` rejects them with a clear error pointing at the
new home.

For source-only packages (`kind = "source"`), omit `[[outputs]]` and
skip `build.toml`; the resolver extracts the tarball into the cache
and exports the extracted dir as `WASM_POSIX_DEP_<NAME>_SRC_DIR` for
consumers to reach into.

### 2b. Write `build.toml`

The **project view** — sits next to `package.toml`. Declares this
project's script path + repo + commit + revision + where the binary
is published. Source-only packages don't need one.

```toml
script_path = "packages/registry/myprog/build-myprog.sh"
repo_url    = "https://github.com/brandonpayton/kandelo.git"
commit      = "<commit at which the recipe was last touched>"
revision    = 1

[binary]
index_url = "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v{abi}/index.toml"
```

- `{abi}` in `index_url` is substituted with the current
  `ABI_VERSION` at resolve time — one `build.toml` survives ABI bumps.
- `revision` bumps invalidate every cached archive for this
  package; bump only when output bytes legitimately change (build
  flag tweaks, fork-instrument output). Don't bump for doc-only changes.
- `commit` is informational provenance; the matrix-build CI step
  reads `git rev-parse HEAD` at publish time and writes the result
  back into the archive's internal manifest's `[compatibility]`
  block.
- For a one-off legacy archive that doesn't live in an index,
  replace the `[binary]` block with the direct form:
  `url = "https://..."` + `sha256 = "..."`. The resolver fetches that
  archive directly without consulting any `index.toml`.

### 3. Write `build-<name>.sh`

The build script's job: produce the declared outputs and call
`install_local_binary` (sourced from `scripts/install-local-binary.sh`)
to register them.

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/sdk/activate.sh"

# Resolve any transitive deps via env vars the resolver injects.
# WASM_POSIX_DEP_ZLIB_DIR is set if zlib is in depends_on; if not,
# resolve on demand.
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-$(cargo run -p xtask --quiet -- build-deps resolve zlib)}"

# … typical autoconf / cmake / make flow, using -I$ZLIB_PREFIX/include
# and -L$ZLIB_PREFIX/lib for compile/link flags. See
# docs/package-management.md §Migrating a consumer to the cache for
# the full CPPFLAGS/LDFLAGS contract.

# Stage outputs into bin/
mkdir -p "$SCRIPT_DIR/bin"
cp <built-path>/myprog "$SCRIPT_DIR/bin/myprog.wasm"

# Register in local-binaries/ so the resolver + run.sh pick up the
# fresh build over any previously-fetched archive.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary myprog "$SCRIPT_DIR/bin/myprog.wasm"
```

### 4. Verify locally

```bash
# Should source-build (no archive yet), populate cache, place
# binaries/programs/<arch>/myprog.wasm.
cargo run -p xtask -- build-deps resolve myprog \
    --arch wasm32 --binaries-dir "$(pwd)/binaries"

# Verify the layout matches what run.sh / consumers expect.
cargo run -p xtask --quiet -- build-deps output-path myprog myprog.wasm
# → myprog.wasm   (single-output, flat)
```

### 5. Open a PR

CI runs `staging-build.yml` on the PR, which:

1. Detects the new package in `preflight` (its `compute-cache-key-sha`
   yields an archive name not yet on the durable release).
2. Runs `archive-stage` for it in `matrix-build`, then invokes
   `scripts/index-update.sh` per matrix entry to atomically upload
   the `.tar.zst` AND mutate the PR's staging `index.toml` entry
   under a workflow-level state-lock.
3. `test-gate` runs the full 5-suite test gate against the union of
   matrix-built + durable-release archives.
4. On `ready-to-ship` + `prepare-merge.yml`, each matrix entry ships
   its archive + index update to the durable `binaries-abi-v<N>`
   release directly — no bot PR amends anything; the `index.toml`
   ledger on the release IS the consumer-visible state.

After the staging workflow has published `index.toml`, use
`./run.sh --pr-staging browser` or
`WASM_POSIX_USE_PR_STAGING=1 ./run.sh browser` to test the PR's
staging release locally without waiting for the durable ABI release.

### 6. Register in `run.sh` (optional)

If users should be able to `./run.sh build <name>` or see the package
in `./run.sh status`, add a `has_<name>` / `build_<name>` pair using
the `pkg_has_output` helper. See PR #445 for the resolver-driven
pattern that derives layout from `package.toml` instead of
hardcoding it.

### Common pitfalls

- **Forgetting `kernel_abi = <current>`.** Required for packages
  with a `[build]` block on the current ABI. The parser rejects the
  manifest otherwise.
- **Hardcoding the output layout in scripts.** Multi-output packages
  go nested (`programs/<arch>/<pkg>/<out>`), single-output flat
  (`programs/<arch>/<out>`). Always query via
  `xtask build-deps output-path` — never duplicate the decision in
  bash.
- **Bumping `revision` for doc-only changes.** A revision bump
  invalidates the cache for that package and triggers a full
  re-source-build across the matrix. Bump only when output bytes
  legitimately change (compiler flag tweaks, fork-instrument output,
  etc.).
- **Source-tree reads instead of declared deps.** If your build
  script reads `packages/registry/<other>/<x>-src/...`, declare `<other>`
  in `depends_on`. The resolver builds deps before you and exports
  their paths via `WASM_POSIX_DEP_<NAME>_DIR` / `_SRC_DIR`. Hidden
  source-tree reads break on clean force-rebuild runs.

## Homebrew Formula Authoring

Homebrew formulae are a second publication surface for already-ported Kandelo
software. Keep the portable package recipe and build script in
`packages/registry/<name>/`; put Homebrew-specific formula state in the
`Automattic/kandelo-homebrew` tap. The main repository's
`homebrew/kandelo-homebrew/` directory is a template and fixture for that tap
shape.

Formulae should use normal Homebrew DSL and call the normal Kandelo build path:

- build through the worktree-local SDK, usually by invoking the package's
  existing `packages/registry/<name>/build-*.sh` script;
- keep cross-compile truth in the package build script with explicit
  `ac_cv_*` cache variables when upstream `configure` would otherwise detect
  host features;
- install the produced Wasm files into the Homebrew keg, not into Kandelo's
  resolver cache;
- put `test do` coverage through Kandelo, for example by running the produced
  Wasm with `examples/run-example.ts`, not by executing it as a host binary;
- leave VFS link plans, browser compatibility, provenance, and validation
  evidence to generated `Kandelo/` sidecars.

Formula Ruby should use `HOMEBREW_KANDELO_*` environment variables for values
that must pass through Homebrew's environment handling:

```text
HOMEBREW_KANDELO_ROOT
HOMEBREW_KANDELO_ARCH
HOMEBREW_KANDELO_NODE
HOMEBREW_KANDELO_LLVM_BIN
```

Workflow scripts outside Formula Ruby use `KANDELO_HOMEBREW_*` variables. See
[docs/homebrew-publishing.md](homebrew-publishing.md) for the trusted publish,
sidecar, VFS builder, Node smoke, and browser smoke contract.

Do not document user-facing `brew tap` or guest `brew install` steps for a
formula until that guest install path has been validated through Kandelo. A
published bottle plus a successful Node VFS smoke proves the bottle can be
poured into a precomposed image; browser support additionally requires the
browser smoke and `browser_compatible = true` metadata.

## Existing Build Scripts

All build scripts are in `packages/registry/`. They serve as reference implementations:

| Software | Script | Build system | Notes |
|----------|--------|-------------|-------|
| dash | `packages/registry/dash/build-dash.sh` | autoconf | Minimal POSIX shell |
| coreutils | `packages/registry/coreutils/build-coreutils.sh` | autoconf | 50+ utilities as multicall binary |
| grep | `packages/registry/grep/build-grep.sh` | autoconf | PCRE not included |
| sed | `packages/registry/sed/build-sed.sh` | autoconf | Straightforward |
| PHP | `packages/registry/php/build-php.sh` | autoconf | CLI + FPM, depends on zlib/libxml2/sqlite/openssl |
| MariaDB | `packages/registry/mariadb/build-mariadb.sh` | CMake | Host build + cross build, Aria storage engine only |
| Redis | `packages/registry/redis/build-redis.sh` | Makefile | Custom make invocation |
| CPython | `packages/registry/cpython/build-cpython.sh` | autoconf | Host build for `_freeze_module`, then cross build |
| nginx | `packages/registry/nginx/build-nginx-local.sh` | custom configure | Shell-based configure script |
| SQLite | `packages/registry/sqlite/build-sqlite.sh` | custom | Single-file amalgamation |
| zlib | `packages/registry/zlib/build-zlib.sh` | custom configure | Dependency for PHP |
| libxml2 | `packages/registry/libxml2/build-libxml2.sh` | CMake | Dependency for PHP |
| OpenSSL | `packages/registry/openssl/build-openssl.sh` | custom Configure | Dependency for PHP |

## SQLite Official Project Tests

SQLite's upstream `test/testrunner.tcl` permutations can be run through
Kandelo with `scripts/run-sqlite-project-unit-tests.sh`. The wrapper runs the
existing official test runner on the Node host, the browser host, or both, and
writes per-host artifacts plus `combined-summary.md` under `test-runs/`.

Build the Tcl and SQLite testfixture prerequisites first:

```bash
bash packages/registry/tcl/build-tcl.sh
bash packages/registry/sqlite/build-testfixture.sh
```

Then run the harness:

```bash
scripts/run-sqlite-project-unit-tests.sh --host both --permutation full
```

Use `--explain` to ask SQLite's testrunner to print the planned jobs without
starting a full permutation run. Browser runs launch the SQLite-only demo page
through Vite with `KANDELO_BROWSER_DEMO_INPUTS=sqlite-test` and disable HMR
with `KANDELO_BROWSER_TEST_NO_HMR=1` so long test runs do not churn on
artifact writes.

## Troubleshooting

**"sysroot not found"**: Run `bash scripts/build-musl.sh` first.

**Graphics shim libraries missing**: Programs using DRM/KMS/GBM/EGL/GLES link
against sysroot libraries built by `scripts/build-musl.sh`. Rebuild the sysroot
with `scripts/dev-shell.sh bash scripts/build-musl.sh`, then use
`wasm32posix-pkg-config --cflags --libs libdrm gbm egl glesv2` from the package
build script. Do not vendor these libraries into the package archive; package
the resulting program or VFS image instead.

**"kandelo-kernel.wasm not found"**: Run `bash build.sh` first.

**Fork fails or the host rejects `asyncify_*` exports**: Rebuild the program
through `scripts/run-wasm-fork-instrument.sh`. Fork-using programs must export
the complete `wpk_fork_*` set. Legacy Asyncify artifacts are intentionally not
accepted. See [fork-instrumentation.md](fork-instrumentation.md).

**"Maximum call stack size exceeded" in browser**: The program's fork-path closure (as discovered by `wasm-fork-instrument --discover-only`) is large. This is rare — the tool instruments only fork-reachable functions, not the whole module. If it happens, check whether `call_indirect` is pulling in a much broader closure than expected. Literal table indexes are checked against active element slots, but dynamic indexes, passive `table.init`, and dynamic table writes remain conservative.

**Process hangs on read**: The fd might be in blocking mode waiting for data. Check that writers are properly closing their end of the pipe.

**Browser SharedArrayBuffer unavailable**: Ensure COOP/COEP headers are set. In production, the service worker handles this. In dev, Vite's config sets them.
