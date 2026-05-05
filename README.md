# wasm-posix-kernel

A POSIX-compliant multi-process kernel for WebAssembly. Compile C programs against a real musl libc, run them in the browser or Node.js with syscall-level compatibility.

**Live demo**: [brandonpayton.github.io/wasm-posix-kernel](https://brandonpayton.github.io/wasm-posix-kernel/)

***ATTENTION:*** This repo may contain .wasm binary builds in its history. In the future, history will likely be rewritten to remove these as they are offloaded to a better data store.

## What runs on it

Real, unmodified software compiled to WebAssembly:

| Software | Version | Notes |
|----------|---------|-------|
| nginx | 1.27 | Static serving, reverse proxy, FastCGI, multi-worker fork |
| PHP | 8.4 | CLI + PHP-FPM, FastCGI protocol |
| MariaDB | 10.5 | SQL database, Aria storage engine, 5 threads |
| Redis | 7.2 | In-memory store, 3 background threads |
| WordPress | 6.7 | Full CMS: nginx + PHP-FPM + SQLite or MariaDB |
| CPython | 3.13 | REPL, script execution, stdlib |
| Git | 2.47 | Core version control operations |
| Vim | 9.1 | Full editor with ncurses terminal UI |
| NetHack | 3.6.7 | Classic roguelike with curses UI |
| fbDOOM | (maximevince) | id Software's DOOM via the kernel's `/dev/fb0` Linux fbdev surface |
| Perl | 5.40 | Interpreter with core modules |
| Ruby | 3.3 | Interpreter with core stdlib |
| QuickJS-NG | 0.12 | ES2023 JavaScript engine + Node.js compat layer |
| GNU nano | 8.3 | Terminal text editor |
| dash | 0.5.12 | POSIX shell with pipes, redirects, job control |
| GNU coreutils | 9.6 | 50+ utilities (ls, cat, sort, wc, etc.) |
| GNU grep | 3.11 | Regular expression search |
| GNU sed | 4.9 | Stream editor |
| GNU make | 4.4 | Build automation |
| curl | 8.11 | HTTP client with TLS |
| wget | 1.25 | HTTP file retrieval |
| gawk | 5.3 | Pattern scanning and processing |
| GNU findutils | 4.10 | find, xargs |
| GNU diffutils | 3.10 | diff, cmp |
| tar | 1.35 | Archive utility |
| gzip, bzip2, xz, zstd | — | Compression utilities |
| less | 668 | Terminal pager |
| bc | 1.07 | Calculator |
| m4 | 1.4.19 | Macro processor |
| file | 5.46 | File type identification |

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

- **Kernel** (Rust → Wasm) — 170+ syscall implementations. One instance manages all processes via a `ProcessTable`.
- **Host** (TypeScript) — Loads kernel and user Wasm binaries, provides host I/O, bridges blocking syscalls to async APIs via `Atomics.waitAsync`.
- **Glue** (C) — Syscall dispatcher compiled into every user program. Translates musl's `__syscall` ABI into channel writes that the kernel reads.

See [docs/architecture.md](docs/architecture.md) for the full architecture reference.

## What's Implemented

170+ POSIX syscalls across these subsystems:

| Subsystem | Highlights |
|-----------|------------|
| File I/O | open, close, read, write, seek, dup/dup2/dup3, pipe, readv/writev, pread/pwrite, sendfile, ftruncate, fsync, copy_file_range, splice, statx |
| fcntl | Advisory locking (F_GETLK/F_SETLK/F_SETLKW), file flags, FD_CLOEXEC, cross-process locks |
| Process | fork (Asyncify), exec, posix_spawn, exit, getpid/getppid, process groups, sessions, waitpid |
| Threads | clone with CLONE_VM\|CLONE_THREAD, per-thread TLS and channels |
| Signals | kill, sigaction (SA_SIGINFO), sigprocmask, sigsuspend, sigaltstack, alarm, setitimer/getitimer, RT signals, sigqueue, sigtimedwait, signalfd |
| Memory | mmap (MAP_ANONYMOUS + MAP_PRIVATE file + MAP_SHARED file), munmap, mremap, brk/sbrk, memfd_create |
| Networking | AF_INET sockets, AF_UNIX sockets, connect, send/recv, sendmsg/recvmsg, SCM_RIGHTS |
| Directories | opendir/readdir, mkdir, rmdir, rename, symlink, readlink, chmod, chown, statvfs, all *at() variants |
| Time | clock_gettime, gettimeofday, nanosleep, utimensat, timer_create/settime/gettime/delete |
| Terminal | Full PTY support (/dev/ptmx + /dev/pts/N), line discipline, canonical/raw mode, 16 terminal ioctls |
| Virtual devices | /dev/null, /dev/zero, /dev/urandom, /dev/full, /dev/fd/N, /dev/tty, /dev/ptmx, /dev/pts/* |
| Procfs | /proc/self, /proc/\<pid\>/stat, status, cmdline, environ, maps, fd/\*, /proc/net/tcp, unix |
| IPC | SysV msg queues, semaphores, shared memory; POSIX mqueues |
| Event/Notification | eventfd, timerfd, signalfd |
| Poll/Select | poll, ppoll, pselect6, epoll (host-intercepted in browser) |

See [docs/posix-status.md](docs/posix-status.md) for the full syscall-by-syscall status.

## Prerequisites

- **Rust nightly** (for `build-std` and atomics) — pinned via `rust-toolchain.toml`
- **LLVM 21+** with `clang` and `wasm-ld` (macOS: `brew install llvm`)
- **Node.js** 22+

Or use the Nix flake (see [Using Nix](#using-nix) below) and skip per-tool installs.

## Using Nix

A `flake.nix` provides a reproducible dev shell with the pinned Rust nightly,
LLVM 21, Node 22, Erlang 28, and the autotools/cmake/binaryen/wabt stack the
build scripts need. With [Nix](https://nixos.org/download.html) installed
(flakes enabled — Determinate Systems Nix has them on by default):

```bash
nix develop                          # interactive shell
# or
nix develop -c bash build.sh         # one-shot
```

The `shellHook` exports `LLVM_BIN` / `LLVM_PREFIX` so the build scripts
pick up the Nix-provided LLVM 21 instead of looking for a Homebrew install.
The first `nix develop` downloads the toolchain (~10–15 min); subsequent
entries are near-instant.

## Quick Start

### 1. Build the kernel

```bash
git submodule update --init musl

# Build musl sysroot (first time only)
bash scripts/build-musl.sh

# Build kernel Wasm + TypeScript host
bash build.sh
```

This builds the kernel from source. Library dependencies (zlib, openssl,
sqlite, etc.) and ported programs (vim, git, php, etc.) are resolved
on demand by `cargo xtask build-deps resolve <name>`, which prefers
the per-user cache, then falls back to the published binary release at
[`binaries-abi-v<ABI_VERSION>`](https://github.com/brandonpayton/wasm-posix-kernel/releases),
then to a source build via the per-library `build-<name>.sh`. See
[docs/package-management.md](docs/package-management.md) for the
full schema, resolution order, and release-archive contract.

If you prefer to skip cargo-driven dep resolution and pull every
pre-built artifact at once, run `bash scripts/fetch-binaries.sh` after
`bash build.sh`. It reads `binaries.lock` and downloads the libraries
into the resolver cache plus the ported programs into
`local-binaries/programs/`.

If you are editing a package's `package.toml` to iterate locally, the
strict cache-key check will abort fetch with a `manifest.json
cache_key_sha ... does not match` error. Pass `--allow-stale` (or set
`WASM_POSIX_ALLOW_STALE=1`) to skip the strict check and source-build
the modified package — see [Iterating on a package locally](docs/package-management.md#iterating-on-a-package-locally).

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
# Build VFS images + start dev server (run.sh handles dependencies)
./run.sh browser

# Or manually:
cd examples/browser
npm install
npx vite --port 5198
```

Open `http://localhost:5198` to try 15 interactive demos — C programs, interactive shell, Python/Perl/Ruby REPLs, nginx, MariaDB, Redis, full WordPress, a LAMP stack, TeX Live, and DOOM — all running in the browser.

Browser demos use pre-built **VFS images** — binary filesystem snapshots that load instantly at runtime. See [docs/browser-support.md](docs/browser-support.md#vfs-images) for details.

## Porting Software

Build scripts for all ported software are in `examples/libs/`:

```bash
bash examples/libs/dash/build-dash.sh          # dash shell
bash examples/libs/coreutils/build-coreutils.sh # GNU coreutils
bash examples/libs/php/build-php.sh             # PHP 8.4
bash examples/libs/redis/build-redis.sh         # Redis 7.2
bash examples/libs/mariadb/build-mariadb.sh     # MariaDB 10.5
bash examples/libs/cpython/build-cpython.sh     # CPython 3.13
bash examples/libs/git/build-git.sh             # Git 2.47
bash examples/libs/vim/build-vim.sh             # Vim 9.1
bash examples/libs/perl/build-perl.sh           # Perl 5.40
bash examples/libs/ruby/build-ruby.sh           # Ruby 3.3
bash examples/libs/quickjs/build-quickjs.sh     # QuickJS-NG + Node.js compat
bash examples/libs/nano/build-nano.sh           # GNU nano 8.3
bash examples/libs/curl/build-curl.sh           # curl
bash examples/libs/make/build-make.sh           # GNU make
```

See [docs/porting-guide.md](docs/porting-guide.md) for how to port your own software.

## Running Tests

```bash
# Kernel unit tests (700 tests)
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib

# Host integration tests (276 tests)
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
  test/              Vitest integration tests
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
  browser/           Browser demo app (Vite + 15 demo pages)
  libs/              Build scripts for ported software (36 packages)
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
| [Package Management](docs/package-management.md) | `examples/libs/<name>/package.toml` schema, resolver, release archives |
| [Package Management — Future Work](docs/package-management-future-work.md) | Deferred items: WASI caching, semver, multi-arch `[binary]`, etc. |
| [Binary Releases](docs/binary-releases.md) | `manifest.json` schema, package-system `.tar.zst` archive layout, fetch + verify flow |
| [Profiling & Benchmarking](docs/profiling.md) | Syscall profiler, benchmark suite, cross-host comparison |
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

This project uses a split license model:

- **GPL-2.0-or-later** — The platform (kernel, host runtime, SDK, build scripts, examples)
- **MIT** — Runtime library components linked into user programs (musl-overlay/ and glue/)

You can compile and run your own programs — including proprietary ones — without the GPL applying to your code. The runtime code linked into your program is MIT-licensed, and the kernel communicates via IPC, not linking.

See [LICENSE](LICENSE) for full details.
