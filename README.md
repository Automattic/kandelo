# Kandelo

Kandelo is a POSIX-compatible multi-process kernel for WebAssembly that runs command-line tools, server stacks, and early graphical demos in the browser or Node.js with syscall-level compatibility.

**Live demo**: [Open Kandelo in the browser](https://automattic.github.io/kandelo/)

**User guide**: [Read the browser and VFS guide](https://automattic.github.io/kandelo/guide/)

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
| SpiderMonkey | 140 ESR | JavaScript engine backing the Node.js-compatible runtime with Intl, SharedArrayBuffer, worker_threads, and npm package installs. |
| GNU nano | 8.3 | Terminal text editor |
| dash | 0.5.12 | POSIX shell with pipes, redirects, job control |
| GNU coreutils | 9.6 | 50+ utilities (ls, cat, sort, wc, etc.) |
| GNU grep | 3.11 | Regular expression search |
| GNU sed | 4.9 | Stream editor |
| GNU make | 4.4 | Build automation |
| curl | 8.11 | HTTP client with TLS |
| GNU Netcat | 0.7.1 | TCP/UDP client and server utility |
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

A single shared kernel serves all processes via channel IPC (SharedArrayBuffer + Atomics):

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
| Process | fork (`wasm-fork-instrument`), exec, posix_spawn, exit, getpid/getppid, process groups, sessions, waitpid |
| Threads | clone with CLONE_VM\|CLONE_THREAD, per-thread TLS and channels |
| Signals | kill, sigaction (SA_SIGINFO), sigprocmask, sigsuspend, sigaltstack, alarm, setitimer/getitimer, RT signals, sigqueue, sigtimedwait, signalfd |
| Memory | mmap (MAP_ANONYMOUS + MAP_PRIVATE file + MAP_SHARED file), munmap, mremap, brk/sbrk, memfd_create |
| Networking | AF_INET UDP/TCP sockets, local virtual networking between Kandelo machines, AF_UNIX sockets, bind/listen/accept/connect, send/recv, sendto/recvfrom, sendmsg/recvmsg, SCM_RIGHTS |
| Directories | opendir/readdir, mkdir, rmdir, rename, symlink, readlink, chmod, chown, statvfs, all *at() variants |
| Time | clock_gettime, gettimeofday, nanosleep, utimensat, timer_create/settime/gettime/delete |
| Terminal | Full PTY support (/dev/ptmx + /dev/pts/N), line discipline, canonical/raw mode, 16 terminal ioctls |
| Virtual devices | /dev/null, /dev/zero, /dev/urandom, /dev/full, /dev/fd/N, /dev/tty, /dev/ptmx, /dev/pts/* |
| Procfs (partial Linux compatibility) | /proc/stat, /proc/meminfo, /proc/self, /proc/\<pid\>/{stat,status,statm,task,cmdline,environ,maps,fd/\*}, /proc/net/{tcp,unix}; virtual size is logical address-space size, while CPU, RSS, and system-memory zeroes mean accounting is unavailable |
| IPC | SysV msg queues, semaphores, shared memory; POSIX mqueues |
| Event/Notification | eventfd, timerfd, signalfd |
| Poll/Select | poll, ppoll, pselect6, epoll (host-intercepted in browser) |

See [docs/posix-status.md](docs/posix-status.md) for the full syscall-by-syscall status.

## Prerequisites

- **Rust nightly** (for `build-std` and atomics) — pinned via `rust-toolchain.toml`
- **LLVM 21+** with `clang` and `wasm-ld` (macOS: `brew install llvm`)
- **Node.js** 24+

Or use the Nix flake (see [Using Nix](#using-nix) below) and skip per-tool installs.

## Using Nix

A `flake.nix` provides a reproducible dev shell with the pinned Rust nightly,
Nix's LLVM 21 package set, Node 24, minimal Erlang 28, and the
autotools/cmake/binaryen/wabt stack the build scripts need. With
[Nix](https://nixos.org/download.html) installed (flakes enabled —
Determinate Systems Nix has them on by default):

```bash
scripts/dev-shell.sh bash            # interactive pure shell
# or
scripts/dev-shell.sh bash build.sh   # one-shot
```

The `shellHook` exports `LLVM_BIN` / `LLVM_PREFIX` / `LLVM_VERSION` so the
build scripts pick up the Nix-provided LLVM toolchain. It also exports the
LLVM source paths used to rebuild the repo's libcxx package reproducibly.
The first shell entry downloads the toolchain (~10–15 min); subsequent entries
are near-instant.

## Quick Start

### Install published packages

For consumers that do not need to rebuild Kandelo itself, the npm
packages are the easiest entry point:

```bash
npm install wasm-posix-host wasm-posix-sdk
```

`wasm-posix-host` ships the compiled host runtime JS, worker entry
points, `kernel.wasm`, and `rootfs.vfs`. `wasm-posix-sdk` ships the
compiler wrappers, musl sysroot, and host glue files used when linking
your own C/C++ programs. You still need LLVM 21+ on `PATH` (or
`WASM_POSIX_LLVM_DIR`) because the SDK wraps clang rather than
bundling a native compiler.

From a source checkout, `npm run pack:packages` builds npm tarballs
after `bash scripts/build-musl.sh` and `bash build.sh` have produced
the sysroot, kernel, and rootfs artifacts.

### 1. Build the kernel

```bash
git submodule update --init libc/musl

# Build musl sysroot (first time only)
bash scripts/build-musl.sh

# Build kernel Wasm + TypeScript host
bash build.sh
```

This builds the kernel from source. Library dependencies (zlib, openssl,
sqlite, libcxx, etc.) and ported programs (vim, git, php, etc.) are resolved
on demand by `cargo xtask build-deps resolve <name>`, which prefers
the per-user cache, then falls back to the published binary release at
[`binaries-abi-v<ABI_VERSION>`](https://github.com/Automattic/kandelo/releases),
then to a source build via the per-library `build-<name>.sh`. See
[docs/package-management.md](docs/package-management.md) for the
full schema, resolution order, and release-archive contract.

If you prefer to skip cargo-driven dep resolution and pull every
pre-built artifact at once, run `bash scripts/fetch-binaries.sh` after
`bash build.sh`. It walks every `packages/registry/<pkg>/package.toml`
with a `[binary.<arch>]` block and resolves the archives into the
content-addressed cache plus `binaries/programs/<arch>/` symlinks.

On PR branches, CI publishes temporary binaries to
`pr-<PR_NUMBER>-staging`. Use `./run.sh --pr-staging browser` or
`WASM_POSIX_USE_PR_STAGING=1 ./run.sh browser` to consume that staging
index locally without editing `build.toml`. A manually set
`WASM_POSIX_BINARY_INDEX_URL` still takes precedence.

If you are editing a package's `package.toml` to iterate locally, the
resolver detects the cache-key mismatch, logs a warning, and falls
through to a source build via the package's `build-<name>.sh` —
no flag needed. See [Iterating on a package
locally](docs/package-management.md#iterating-on-a-package-locally).

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

### 4. Try Kandelo in the browser

```bash
# Build VFS images + start dev server (run.sh handles dependencies)
./run.sh browser

# Or manually:
cd apps/browser-demos
npm install
npm run dev
```

Open `http://127.0.0.1:5401` to use the Kandelo UI. The network lab at `http://127.0.0.1:5401/pages/network/` boots multiple local Kandelo machines in one browser session and exercises POSIX UDP/TCP with GNU Netcat (`nc`) and `curl`.

The browser app routes cross-origin fetches through the service worker and
defaults to the main WordPress Playground CORS proxy:
`https://wordpress-playground-cors-proxy.net/?`. To test an alternate proxy in
dev, preview, or production builds, set `VITE_CORS_PROXY_URL` before starting or
building the browser app:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```

Proxy prefixes ending in a bare `?` receive the raw target URL. Other prefix
forms, such as `https://your-proxy.example/cors?url=`, receive a
percent-encoded target URL. If you change the proxy while a service worker is
already active, reload the page; clearing site data may be needed if the browser
keeps an older service worker around.

Browser Kandelo supports local loopback and virtual machine-to-machine UDP/TCP. External raw TCP/UDP sockets are still constrained by the browser sandbox and require fetch, service-worker, proxy, or future WebRTC-backed transports behind the POSIX socket layer.

The browser UI uses pre-built **VFS images** - binary filesystem snapshots that load instantly at runtime. See [docs/browser-support.md](docs/browser-support.md#vfs-images) for details.

## Porting Software

Build scripts for all ported software are in `packages/registry/`:

```bash
bash packages/registry/dash/build-dash.sh          # dash shell
bash packages/registry/coreutils/build-coreutils.sh # GNU coreutils
bash packages/registry/php/build-php.sh             # PHP 8.4
bash packages/registry/redis/build-redis.sh         # Redis 7.2
bash packages/registry/mariadb/build-mariadb.sh     # MariaDB 10.5
bash packages/registry/cpython/build-cpython.sh     # CPython 3.13
bash packages/registry/git/build-git.sh             # Git 2.47
bash packages/registry/vim/build-vim.sh             # Vim 9.1
bash packages/registry/perl/build-perl.sh           # Perl 5.40
bash packages/registry/ruby/build-ruby.sh           # Ruby 3.3
bash packages/registry/spidermonkey/build-spidermonkey.sh # SpiderMonkey JS + Node.js compat
bash packages/registry/nano/build-nano.sh           # GNU nano 8.3
bash packages/registry/curl/build-curl.sh           # curl
bash packages/registry/netcat/build-netcat.sh        # GNU Netcat 0.7.1
bash packages/registry/make/build-make.sh           # GNU make
```

See [docs/porting-guide.md](docs/porting-guide.md) for how to port your own software.

## Running Tests

```bash
# Kernel unit tests (700 tests)
cargo test -p kandelo --target aarch64-apple-darwin --lib

# Host, package, and browser-adjacent integration tests
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
  src/               TypeScript host runtime shared by Node.js and browser hosts
    node-kernel-host.ts / node-kernel-worker-entry.ts
                      Node.js host main-thread proxy and kernel worker entry
    browser-kernel-host.ts / browser-kernel-worker-entry.ts
                      Browser host main-thread proxy and kernel worker entry
    worker-main.ts   Shared process-worker runtime used by both hosts
    vfs/ networking/ framebuffer/
                      Shared host services used by Node.js, browser, and tests
  test/              Host/kernel runtime behavior tests
  wasm/              Compiled Wasm binaries
sdk/
  src/bin/           CLI tool wrappers for LLVM cross-compilation
  src/lib/           Toolchain discovery, compiler flags, arg parsing
apps/
  browser-demos/     Vite Kandelo UI app that consumes the browser host runtime
web-libs/
  kandelo-session/   Reusable Kandelo session/UI integration contracts
packages/
  registry/          Kandelo package manifests and build scripts
    <name>/test/     Package-owned tests and fixtures
  sets/              Named package sets for CI and product scenarios
tests/
  package-system/    Package registry and binary-fetching automation tests
  libc/              musl libc-test suite and overlays
  posix/             Open POSIX test suite
  sortix/            Sortix os-test suite and overlays
images/
  rootfs/            Source tree for the base VFS image
  vfs/scripts/       VFS image and archive builders
tools/
  mkrootfs/          Root filesystem image builder
  xtask/             Rust package/release automation CLI
libc/glue/
  channel_syscall.c  Channel-based syscall dispatcher (compiled into every user program)
  compiler_rt.c      Soft-float and 64-bit compiler runtime builtins
libc/musl/                musl libc (git submodule)
libc/musl-overlay/        Wasm32-specific architecture patches for musl
tests/
  libc/              musl libc-test submodule, overlays, and build output
  posix/             Open POSIX test suite
  sortix/            Sortix os-test submodule and build output
scripts/             Build scripts and test runners
examples/
  *.c / *.wasm       Simple C example programs
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
| [User Guide](https://automattic.github.io/kandelo/guide/) | Browser UI usage, custom browser apps, VFS images, publishing, and API stability notes |
| [Architecture](docs/architecture.md) | Kernel design, syscall flow, multi-process model, memory layout |
| [Repository Organization](docs/repository-organization.md) | Top-level ownership boundaries and CI-oriented path categories |
| [SDK Guide](docs/sdk-guide.md) | Compiling programs, toolchain setup, autoconf/CMake integration |
| [Porting Guide](docs/porting-guide.md) | How to port software and create package builds |
| [Browser Support](docs/browser-support.md) | Browser architecture, capabilities, and limitations |
| [Shareable Computer URLs](docs/plans/2026-05-11-shareable-computer-url-design.md) | Boot descriptor design for sharing computer topology, signed bases/packages, mounts, and overlays |
| [Package Management](docs/package-management.md) | `packages/registry/<name>/package.toml` schema, resolver, release archives |
| [Package Sources](docs/package-sources.md) | Reusable workflows and scripts for third-party Kandelo package repositories |
| [Package Management — Future Work](docs/package-management-future-work.md) | Deferred items: WASI caching, semver, multi-arch `[binary]`, etc. |
| [Binary Releases](docs/binary-releases.md) | `index.toml` ledger, package-system `.tar.zst` archive layout, fetch + verify flow |
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

4. **Multi-process**: `fork()` uses `wasm-fork-instrument` to snapshot and restore the Wasm call stack. The host copies process memory to a new Web Worker, and the child resumes from the fork point. `exec()` replaces the process image by terminating the old worker and starting a new one with fresh memory. Cross-process pipes, signals, and locks are coordinated through the shared kernel instance.

## License

This project uses a split license model:

- **GPL-2.0-or-later** — The platform (kernel, host runtime, SDK, build scripts, examples)
- **MIT** — Runtime library components linked into user programs (libc/musl-overlay/ and libc/glue/)

You can compile and run your own programs — including proprietary ones — without the GPL applying to your code. The runtime code linked into your program is MIT-licensed, and the kernel communicates via IPC, not linking.

See [LICENSE](LICENSE) for full details.
