# wasm-posix-kernel

A POSIX-compliant kernel for WebAssembly. Compile C programs against a real musl libc, run them in the browser or Node.js with syscall-level compatibility.

**Live demo**: [brandonpayton.github.io/wasm-posix-kernel](https://brandonpayton.github.io/wasm-posix-kernel/)

## What runs on it

Real, unmodified software compiled to WebAssembly:

| Software | Version | Features |
|----------|---------|----------|
| nginx | 1.27 | Static file serving, reverse proxy, FastCGI, multi-worker fork |
| PHP | 8.4 | CLI + PHP-FPM, FastCGI protocol |
| MariaDB | 10.5 | Full SQL database, 5 threads (Aria storage engine) |
| Redis | 7.2 | In-memory store, 3 background threads |
| WordPress | 6.7 | Full CMS with nginx + PHP-FPM + SQLite/MariaDB |
| CPython | 3.13 | REPL, script execution, stdlib |
| dash | 0.5.12 | POSIX shell with pipes, redirects, job control |
| GNU coreutils | 9.6 | 50+ utilities (ls, cat, grep, sed, sort, etc.) |
| GNU grep | 3.11 | Regular expression search |
| GNU sed | 4.9 | Stream editor |

All run in both Node.js and the browser with no source modifications.

## Architecture

A centralized kernel serves all processes via channel IPC (SharedArrayBuffer + Atomics):

```
┌─────────────────────────────────────────┐
│  User Programs (C → Wasm)               │
│  Each in its own Web Worker             │
│  Linked against musl libc + glue        │
├─────────────────────────────────────────┤
│  Kernel (Rust → Wasm)                   │
│  One instance, all processes            │
│  Syscalls, fd table, pipes, signals,    │
│  sockets, PTY, memory management        │
├─────────────────────────────────────────┤
│  Host Runtime (TypeScript)              │
│  Node.js: fs, net, crypto               │
│  Browser: SharedArrayBuffer FS, fetch   │
└─────────────────────────────────────────┘
```

- **Kernel** (Rust → Wasm) — 140+ syscall implementations. One instance manages all processes via a `ProcessTable`.
- **Host** (TypeScript) — Loads kernel and user Wasm binaries, provides host I/O, bridges blocking syscalls to async APIs via `Atomics.waitAsync`.
- **Glue** (C) — Syscall dispatcher compiled into every user program. Translates musl's `__syscall` ABI into channel writes that the kernel reads.

See [docs/architecture.md](docs/architecture.md) for the full architecture reference.

## What's Implemented

140+ POSIX syscalls across these subsystems:

| Subsystem | Highlights |
|-----------|------------|
| File I/O | open, close, read, write, seek, dup/dup2/dup3, pipe, readv/writev, pread/pwrite, sendfile, ftruncate, fsync |
| fcntl | Advisory locking (F_GETLK/F_SETLK/F_SETLKW), file flags, FD_CLOEXEC, cross-process locks |
| Process | fork (Asyncify), exec, posix_spawn, exit, getpid/getppid, process groups, sessions, waitpid |
| Threads | clone with CLONE_VM\|CLONE_THREAD, per-thread TLS and channels |
| Signals | kill, sigaction (SA_SIGINFO), sigprocmask, sigsuspend, sigaltstack, alarm, setitimer/getitimer, RT signals |
| Memory | mmap (MAP_ANONYMOUS + MAP_PRIVATE file), munmap, brk/sbrk, RLIMIT_AS |
| Networking | AF_INET sockets, AF_UNIX sockets, connect, send/recv, getaddrinfo, SCM_RIGHTS |
| Directories | opendir/readdir, mkdir, rmdir, rename, symlink, readlink, chmod, chown, statvfs |
| Time | clock_gettime, gettimeofday, nanosleep, utimensat, timer_create/settime |
| Terminal | Full PTY support (/dev/ptmx + /dev/pts/N), line discipline, tcgetattr/tcsetattr, TIOCGWINSZ |
| Virtual devices | /dev/null, /dev/zero, /dev/urandom, /dev/full, /dev/fd/N, /dev/stdin, /dev/stdout, /dev/stderr |
| IPC | SysV msg queues, semaphores, shared memory; POSIX mqueues |
| Poll/Select | poll, ppoll, pselect6, epoll (host-intercepted in browser) |

See [docs/posix-status.md](docs/posix-status.md) for the full syscall-by-syscall status.

## Prerequisites

- **Rust nightly** (for `build-std` and atomics)
- **LLVM 21+** with `clang` and `wasm-ld` (macOS: `brew install llvm`)
- **Node.js** 22+

## Quick Start

### 1. Build the kernel

```bash
git submodule update --init musl

# Build musl sysroot (first time only)
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
| `wasm32posix-strip` | Symbol stripper (no-op) |
| `wasm32posix-pkg-config` | pkg-config with sysroot awareness |
| `wasm32posix-configure` | Autoconf configure wrapper |

See [docs/sdk-guide.md](docs/sdk-guide.md) for detailed SDK usage.

### 3. Compile and run a C program

```bash
wasm32posix-cc examples/hello.c -o hello.wasm
npx tsx examples/run-example.ts hello
```

### 4. Try the browser demos

```bash
cd examples/browser
npm install
npx vite --port 5198
```

Open `http://localhost:5198` to run C programs, an interactive shell, Python REPL, nginx, MariaDB, Redis, or full WordPress — all in the browser.

## Porting Software

Build scripts for all ported software are in `examples/libs/`:

```bash
bash examples/libs/dash/build-dash.sh          # dash shell
bash examples/libs/coreutils/build-coreutils.sh # GNU coreutils
bash examples/libs/php/build-php.sh             # PHP 8.4
bash examples/libs/redis/build-redis.sh         # Redis 7.2
bash examples/libs/mariadb/build-mariadb.sh     # MariaDB 10.5
bash examples/libs/cpython/build-cpython.sh     # CPython 3.13
```

See [docs/porting-guide.md](docs/porting-guide.md) for how to port your own software.

## Running Tests

```bash
# Kernel unit tests (610+ tests)
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib

# Host integration tests (227+ tests)
cd host && npx vitest run

# musl libc-test suite (0 unexpected failures)
scripts/run-libc-tests.sh

# Open POSIX test suite (0 failures)
scripts/run-posix-tests.sh

# Sortix test suite (4817+ pass, 0 failures)
scripts/run-sortix-tests.sh --all
```

## Project Structure

```
crates/
  shared/            Shared types (Errno, syscall numbers, flags, channel layout)
  kernel/            Kernel implementation (syscalls, fd table, signals, pipes, sockets, PTY)
  userspace/         User-space stub library
host/
  src/               TypeScript host runtime (kernel loader, VFS, networking, workers)
  test/              Vitest integration tests (227+ tests)
  wasm/              Compiled Wasm binaries
sdk/
  src/bin/           CLI tool wrappers for LLVM cross-compilation
  src/lib/           Toolchain discovery, compiler flags, arg parsing
glue/
  channel_syscall.c  Channel-based syscall dispatcher (compiled into every user program)
  compiler_rt.c      Soft-float and 64-bit compiler runtime builtins
musl/                musl libc (git submodule)
musl-overlay/        Wasm32-specific architecture patches for musl
scripts/             Build scripts, test runners (libc-test, POSIX, Sortix)
examples/
  *.c / *.wasm       Simple C example programs
  browser/           Browser demo app (Vite + 10 demo pages)
  libs/              Build scripts for ported software (PHP, MariaDB, Redis, etc.)
docs/
  architecture.md    Architecture reference
  sdk-guide.md       SDK usage guide
  porting-guide.md   Guide to porting software and creating demos
  browser-support.md Browser capabilities and limitations
  posix-status.md    Full syscall-by-syscall status tracker
  wasm-limitations.md  Fundamental WebAssembly platform limitations
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | Kernel design, syscall flow, multi-process model, memory layout |
| [SDK Guide](docs/sdk-guide.md) | Compiling programs, toolchain setup, autoconf/CMake integration |
| [Porting Guide](docs/porting-guide.md) | How to port software, create Node.js and browser demos |
| [Browser Support](docs/browser-support.md) | Browser architecture, capabilities, demo list, limitations |
| [POSIX Status](docs/posix-status.md) | Syscall-by-syscall implementation status |
| [Wasm Limitations](docs/wasm-limitations.md) | Fundamental platform constraints |

## How It Works

1. **Compilation**: C source → clang (wasm32-unknown-unknown) → linked against musl `libc.a` + glue layer. The glue translates musl's `__syscall(number, args...)` into typed writes to a SharedArrayBuffer channel.

2. **Loading**: The TypeScript host instantiates the kernel Wasm module with host I/O imports, then creates process workers that each get their own Wasm memory with a channel region.

3. **Syscall execution**: When user code calls e.g. `open("/etc/hosts", O_RDONLY)`:
   - musl `open()` → `__syscall(SYS_openat, AT_FDCWD, path, flags, mode)`
   - Glue writes syscall number + args to the channel, then `Atomics.store(status, SYSCALL_READY)` + `Atomics.notify()`
   - Kernel worker wakes, reads channel, dispatches to `sys_open()`, writes result back
   - Glue resumes with the return value (fd or negative errno)

4. **Multi-process**: `fork()` uses Binaryen Asyncify to snapshot the Wasm call stack. The host copies process memory to a new Web Worker, and the child resumes from the fork point. `exec()` replaces the process image by terminating the old worker and starting a new one with fresh memory. Cross-process pipes, signals, and locks are coordinated through the shared kernel instance.

## License

MIT
