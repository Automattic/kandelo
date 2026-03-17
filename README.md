# wasm-posix-kernel

A POSIX-compliant kernel for WebAssembly. Compile C programs against a real musl libc, run them in the browser or Node.js with syscall-level compatibility.

## Architecture

Three layers:

- **Kernel** (Rust → Wasm) — Syscall implementations: file descriptors, signals, process management, pipes, sockets, virtual devices. Runs in shared memory alongside user programs.
- **Host** (TypeScript) — Runtime that loads the kernel and user Wasm binaries, provides host I/O (filesystem, networking, random), and bridges blocking syscalls to async platform APIs via `Atomics.wait()`.
- **Glue** (C) — Thin syscall dispatcher compiled into every user program. Translates musl's `__syscall` ABI into typed kernel imports.

```
┌─────────────────────────────────────────┐
│  User Program (C → Wasm)                │
│  linked against musl libc + glue        │
├─────────────────────────────────────────┤
│  Kernel (Rust → Wasm)                   │
│  syscalls, fd table, signals, pipes,    │
│  sockets, virtual devices, memory mgmt  │
├─────────────────────────────────────────┤
│  Host Runtime (TypeScript)              │
│  Node.js: fs, net, crypto               │
│  Browser: fetch, OPFS, WebCrypto        │
└─────────────────────────────────────────┘
```

## What's Implemented

140+ POSIX syscalls across these subsystems:

| Subsystem | Highlights |
|-----------|------------|
| File I/O | open, close, read, write, seek, dup/dup2/dup3, pipe, readv/writev, pread/pwrite, sendfile, ftruncate, fsync |
| fcntl | Advisory locking (F_GETLK/F_SETLK/F_SETLKW), file flags, FD_CLOEXEC, cross-process locks via SharedArrayBuffer |
| Process | fork/exec (host-initiated), exit, getpid/getppid, uid/gid/euid/egid, process groups, sessions, waitpid |
| Signals | kill, sigaction, sigprocmask, sigsuspend, alarm, setitimer/getitimer, pending signal delivery at syscall boundaries |
| Memory | mmap (MAP_ANONYMOUS), munmap, brk/sbrk |
| Networking | AF_INET sockets, connect, send/recv, getaddrinfo, setsockopt, Unix domain sockets (local) |
| Directories | opendir/readdir/closedir, mkdir, rmdir, rename, symlink, readlink, chmod, chown |
| Time | clock_gettime, gettimeofday, nanosleep, utimensat |
| Terminal | isatty, tcgetattr/tcsetattr, ioctl (TIOCGWINSZ, FIONREAD, FIONBIO) |
| Virtual devices | `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/full`, `/dev/fd/N`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` |
| Poll/Select | poll, ppoll, pselect6, epoll stubs |

See [docs/posix-status.md](docs/posix-status.md) for the full syscall-by-syscall status.

## Prerequisites

- **Rust nightly** (for `build-std` and atomics)
- **LLVM 21+** with `clang` and `wasm-ld` (macOS: `brew install llvm`)
- **Node.js** 22+

## Quick Start

### 1. Build the kernel

```bash
# Build musl sysroot (first time only)
git submodule update --init musl
bash scripts/build-musl.sh

# Build kernel Wasm + TypeScript host
bash build.sh
```

### 2. Install the SDK

```bash
cd sdk && npm link
```

This installs 8 CLI tools that wrap LLVM for the `wasm32-posix` target:

| Tool | Purpose |
|------|---------|
| `wasm32posix-cc` | C compiler |
| `wasm32posix-c++` | C++ compiler |
| `wasm32posix-ar` | Static archive tool |
| `wasm32posix-ranlib` | Archive index generator |
| `wasm32posix-nm` | Symbol lister |
| `wasm32posix-strip` | Symbol stripper |
| `wasm32posix-pkg-config` | pkg-config wrapper |
| `wasm32posix-configure` | Autoconf configure wrapper |

The SDK auto-detects LLVM via `$WASM_POSIX_LLVM_DIR`, PATH, Homebrew, or Linux system paths.

### 3. Compile and run a C program

```bash
wasm32posix-cc examples/hello.c -o hello.wasm

cd host
node --experimental-strip-types src/run.ts ../hello.wasm
```

## Examples

The [examples/](examples/) directory has C programs covering file I/O, directories, environment variables, memory allocation, networking, and file locking. A browser demo with Vite is in `examples/browser/`. Build scripts for PHP, SQLite, libxml2, OpenSSL, and zlib are in `examples/libs/`.

## Browser Usage

Programs run in Web Workers using `SharedArrayBuffer` for blocking syscall support. Your server must set these headers:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

```typescript
import { WasmPosixKernel } from 'wasm-posix-host/browser';

const kernel = new WasmPosixKernel({
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
});

await kernel.boot(kernelWasmBytes);
const exitCode = await kernel.run(programWasmBytes, {
  args: ['program', '--flag'],
  env: { HOME: '/home/user', TERM: 'xterm-256color' },
});
```

A demo is in `examples/browser/` — run it with `cd examples/browser && npm run dev`.

See [docs/browser-support.md](docs/browser-support.md) for details.

## Running Tests

```bash
# Kernel unit tests (432 tests)
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib

# Host integration tests (164 tests)
cd host && npx vitest run

# SDK tests (31 tests)
cd sdk && npx vitest run
```

## Project Structure

```
crates/
  shared/          Shared types (Errno, flags, WasmStat)
  kernel/          Kernel implementation (syscalls, fd table, signals, pipes, sockets)
  userspace/       User-space stub library
host/
  src/             TypeScript runtime (kernel loader, networking, filesystem)
  wasm/            Compiled Wasm binaries
  test/            Integration tests
sdk/
  src/bin/         CLI tool wrappers for LLVM
glue/
  syscall_glue.c   Syscall dispatcher (musl __syscall → kernel imports)
  syscall_imports.h Kernel import declarations
  compiler_rt.c    Compiler runtime support
musl/              musl libc (git submodule)
musl-overlay/      Wasm32-specific patches for musl
scripts/
  build-musl.sh    Build musl sysroot from source (first-time setup)
  run-libc-tests.sh  Run libc-test suite against the kernel
examples/          30+ example C programs + browser demo
docs/              POSIX compliance tracker, browser docs, design plans
```

## How It Works

1. **Compilation**: C source is compiled with clang targeting `wasm32-unknown-unknown`, linked against musl's `libc.a` and the glue layer. The glue translates musl's generic `__syscall(number, args...)` into typed calls to kernel Wasm imports like `kernel_open(path, flags, mode)`.

2. **Loading**: The TypeScript host instantiates the kernel Wasm module with host I/O imports (filesystem, networking, crypto), then instantiates the user program Wasm module with the kernel's exports as its imports. Both share the same linear memory.

3. **Execution**: When user code calls `open("/dev/urandom", O_RDONLY)`, it flows: musl `open()` → `__syscall(SYS_openat, ...)` → glue `syscall_handler()` → kernel `kernel_openat()` → `sys_open()` recognizes `/dev/urandom` → creates CharDevice OFD with virtual device handle → returns fd. Subsequent `read()` calls on that fd route to `host_getrandom()` → `crypto.getRandomValues()`.

4. **Multi-process**: `fork()` is host-initiated — the host spawns a new Web Worker, serializes kernel state via SharedArrayBuffer, and the child process resumes with a copy of the parent's fd table, signals, and environment. Cross-process pipes and advisory file locks use SharedArrayBuffer for coordination.
