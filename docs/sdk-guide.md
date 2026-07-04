# SDK Guide

The wasm-posix-sdk provides a cross-compilation toolchain for building C/C++ programs that run on Kandelo. It wraps LLVM tools with the correct flags for the `wasm32-unknown-unknown` target and links against the musl libc sysroot.

## Installation

### Prerequisites

1. **LLVM 21+** with clang and wasm-ld:
   - macOS: `brew install llvm`
   - Ubuntu: `apt install llvm clang lld`
   - Or use the Nix dev shell wrapper (`scripts/dev-shell.sh bash` from the
     repo root) — provides LLVM 21 plus the rest of the toolchain, no per-tool
     install needed.
     See the README's "Using Nix" section.
2. **musl sysroot**. If you installed `wasm-posix-sdk` from npm, the
   package already contains the published sysroot and glue files. If
   you are working from a source checkout, build them locally:
   ```bash
   git submodule update --init libc/musl
   bash scripts/build-musl.sh
   ```
3. **Kernel built**:
   ```bash
   bash build.sh
   ```

### Install the SDK

```bash
npm install -D wasm-posix-sdk

# or, from a source checkout:
cd sdk
npm link
```

This makes 8 CLI tools available globally:

| Tool | Purpose |
|------|---------|
| `wasm32posix-cc` | C compiler (wraps clang) |
| `wasm32posix-c++` | C++ compiler (wraps clang++) |
| `wasm32posix-ar` | Static archive tool (wraps llvm-ar) |
| `wasm32posix-ranlib` | Archive index generator (wraps llvm-ranlib) |
| `wasm32posix-nm` | Symbol lister (wraps llvm-nm) |
| `wasm32posix-strip` | Symbol stripper (no-op for Wasm) |
| `wasm32posix-pkg-config` | pkg-config with sysroot awareness |
| `wasm32posix-configure` | Autoconf `./configure` wrapper |

### LLVM Discovery

The SDK finds LLVM in this order:

1. `$WASM_POSIX_LLVM_DIR` environment variable (path to LLVM bin directory)
2. `clang` on `$PATH` (tested for wasm32 support — covers the Nix dev shell,
   which puts the pinned LLVM 21 first on `PATH`)
3. `/opt/homebrew/opt/llvm/bin` (macOS Homebrew)
4. `/usr/lib/llvm-*/bin` (Linux, highest version)

### Glue and Sysroot Discovery

The SDK locates `libc/glue/` and `sysroot/` in this order:

1. `$WASM_POSIX_GLUE_DIR` / `$WASM_POSIX_SYSROOT` env vars (explicit overrides)
2. Walk up from `process.cwd()` looking for `libc/glue/abi_constants.h` — anchors to the project root the user is building from
3. Fall back to the SDK's sibling-repository directory (the `..` of the npm-linked package)

The cwd-walk-up step matters when the SDK is `npm link`-ed: the global `wasm32posix-cc` symlink points at whichever worktree last ran `npm link`, but libc/glue/sysroot must come from the worktree the user is actively building in (otherwise programs link against a different `ABI_VERSION` than the kernel they will run on). If you keep multiple worktrees, you do not need to re-`npm link` when switching between them — the SDK resolves libc/glue/sysroot from your shell's cwd.

## Compiling Programs

### Simple C program

```bash
# Compile and link in one step
wasm32posix-cc hello.c -o hello.wasm

# Run it
npx tsx examples/run-example.ts hello.wasm
```

### Compile-only (produce .o)

```bash
wasm32posix-cc -c foo.c -o foo.o
wasm32posix-cc -c bar.c -o bar.o
wasm32posix-cc foo.o bar.o -o program.wasm
```

### With optimization

```bash
wasm32posix-cc -O2 program.c -o program.wasm
```

### C++ programs

```bash
wasm32posix-c++ program.cpp -o program.wasm
```

### Linking C++ programs (with exceptions)

C++ programs link against libc++ + libc++abi. Both are produced by
the libcxx package (`packages/registry/libcxx/`) and resolved automatically
by `cargo xtask build-deps resolve libcxx`. LLVM libunwind is statically
bundled into `libc++abi.a`, so:

```bash
wasm32posix-c++ -fwasm-exceptions main.cpp -lc++ -lc++abi -o app.wasm
```

works out of the box — `_Unwind_*` symbols resolve internally, no
separate `-lunwind`.

`-fwasm-exceptions` is required for clang to lower C++ `try`/`catch`
to wasm-EH `try_table` / `catch_ref` instructions. Without it, catch
handlers are dead-code-eliminated and `throw` hangs at runtime.

#### LLVM 21 SjLj and `noexcept` limitation

Kandelo's pinned LLVM 21.1.7 toolchain lowers `longjmp` and `siglongjmp` to an
internal Wasm exception. If that transfer crosses a C++ `noexcept` frame,
Clang's generated termination handler can intercept the internal tag before
the matching `setjmp` or `sigsetjmp` landing consumes it. The process then
calls `std::terminate()` even when the C control transfer itself is valid.

This is a known SDK/toolchain limitation tracked in
[issue #918](https://github.com/Automattic/kandelo/issues/918), not a change to
POSIX signal or `longjmp` semantics. It is present in raw clang-linked wasm32
and wasm64 modules and remains present after Kandelo's wasm32 fork
instrumentation. Until the pinned compiler is fixed, code that establishes a
jump landing and calls work that can jump back across the current frame must
not mark that crossed frame `noexcept`. Keep the workaround scoped to that
boundary; do not disable C++ exceptions, signal delivery, or child reaping.

### Building static libraries

```bash
wasm32posix-cc -c lib_a.c -o lib_a.o
wasm32posix-cc -c lib_b.c -o lib_b.o
wasm32posix-ar rcs libfoo.a lib_a.o lib_b.o
wasm32posix-cc main.c -L. -lfoo -o program.wasm
```

The compiler wrapper preserves the caller's linker-input order. Objects,
explicit archives, `-l` libraries, and linker group controls reach Clang in
the same relative sequence supplied by the build system, as required by
normal static archive resolution.

### With dynamic loading (dlopen)

```bash
# Build main program with dlopen support
wasm32posix-cc -ldl main.c -o main.wasm

# Build shared library
wasm32posix-cc -shared -fPIC plugin.c -o plugin.so
```

## What the SDK Does

### Compiler flags injected automatically

```
--target=wasm32-unknown-unknown    # Wasm target triple
-matomics                          # Enable atomics (SharedArrayBuffer)
-mbulk-memory                      # Enable bulk memory operations
-mexception-handling               # Enable Wasm exception handling
-mllvm -wasm-enable-sjlj           # Enable setjmp/longjmp
# Modern wasm-EH lowering (try_table/catch_ref) is LLVM's default
# since version ≥17; we no longer override with `-wasm-use-legacy-eh=true`
# (removed in commit 9 of the fork-instrument mega-PR, 2026-05-14).
-fno-trapping-math                 # Non-trapping FP (Wasm requirement)
--sysroot=<path>                   # musl sysroot
```

The musl objects in the SDK sysroot are compiled with the same Wasm exception
handling and SjLj lowering flags, so libc calls to `setjmp`/`longjmp` do not
leave unresolved host imports in linked programs.

### Linker flags injected automatically

```
-nostdlib                          # Don't use system libc
-Wl,--entry=_start                 # Entry point
-Wl,--import-memory                # Memory provided by host
-Wl,--shared-memory                # Enable SharedArrayBuffer
-Wl,--max-memory=1073741824        # 1GB max memory
-Wl,-z,stack-size=8388608          # 8 MiB main-thread shadow stack (see below)
-Wl,--global-base=1114112          # Data segment start
-Wl,--no-stack-first               # LLVM 22+: preserve stack-after-data layout
-Wl,--allow-undefined              # Host imports are resolved at load time
-Wl,--export-table                 # Export function table (for dlopen)
-Wl,--export=__stack_pointer       # Required for fork/thread support
-Wl,--export=__tls_base            # Required for TLS
-Wl,--export=__wasm_init_tls       # TLS initialization
```

#### Why an 8 MiB main-thread stack

wasm-ld's default shadow stack is only ~64 KiB. WebAssembly has **no stack
guard page**, so a program that overflows the shadow stack does not fault at the
overflow — `__stack_pointer` simply keeps decrementing past `__data_end` and
silently overwrites whatever lives at the top of `.bss`. On this platform that
region holds the pthread/TLS globals (`__wasm_tp_storage`, the main thread's
`struct pthread`, and `__pthread_tsd_main`), so an overflow corrupts thread-local
storage and later surfaces as a **spurious "memory access out of bounds"** in an
unrelated function (e.g. `__pthread_getspecific` or `pthread_mutex_lock`) — far
from the actual overflow. Deep call chains in ordinary libraries hit this
easily; GTK's `gdk_pixbuf_new_from_file` → GObject type-registration → glib
chain is one confirmed case (see `docs/kandelo-lxde-desktop-demo.md`).

POSIX does **not** mandate a default stack size — it is implementation-defined,
with `RLIMIT_STACK` governing the main thread. We reserve **8 MiB** because that
is the de-facto default soft `RLIMIT_STACK` on Linux/glibc (and macOS), so the
large body of C software written and tested on Linux already assumes it fits
within those bounds. Because a WebAssembly shadow stack cannot grow at runtime,
the reservation is fixed at link time.

Scope and cost:
- **Main thread only.** This flag sizes the process's initial shadow stack.
  Threads created via `pthread_create` get their own stacks from musl's
  `__default_stacksize` (128 KiB by default), independent of this flag — an
  8 MiB main stack does **not** multiply per thread.
- **At least ~8 MiB of initial linear memory per process.** A larger stack raises
  `__heap_base` 1:1, so each process instance reserves the extra space up front.
  This is per-process; a `fork()`ed child is a separate address space with the
  same configured main stack size.
- The engine's native Wasm call stack (operand stack / call frames) is separate
  and host/engine-managed; it is not part of this linear-memory reservation.

The SDK treats 8 MiB as a floor. It appends the larger of that floor and every
valid user stack request after the other linker arguments, where lld gives it
final precedence. The Node-hosted driver first asks pinned Clang for a `-###`
job trace without injecting executable glue. Compiler-only traces, including
`-fsyntax-only`, dependency generation, and analyzer jobs hidden in response
files, continue without link preparation. Confirmed executable links get a
second `-###` trace with the complete SDK link inputs, and the SDK scans the
exact `wasm-ld` argument vector Clang emits. This leaves option classification
and ordering in Clang: positional inputs, `-Wl,`, `-Xlinker`, and direct `-z`
transports cannot be misclassified by a duplicate SDK option table. A failed,
missing, or ambiguous linker trace aborts before the real link. These traces are
driver-only invocations and do not compile; they add two Clang processes per
executable link and one for an otherwise-unrecognized compiler-only mode.

The Kandelo-native driver also uses a non-compiling Clang job trace to preserve
compiler-only modes before entering its manual link path. For a confirmed link,
it invokes the adjacent `wasm-ld` directly and scans the exact linker arguments
it has already classified.

Relative lld response paths follow Clang's effective `-working-directory`,
including when that option comes from a top-level Clang response file,
configuration file, or environment override. The SDK reads the driver-owned cwd
slot in the pinned Clang trace and fails before linking if the trace omits or
contradicts that invariant. Debug, coverage, and file compilation-directory
options do not affect linker response resolution.

LLVM 21 accepts the lld forms `-z stack-size=<bytes>` and
`-zstack-size=<bytes>`. Stack sizes follow LLVM 21's radix-0 integer syntax:
decimal, leading-zero or `0o` octal, `0x`/`0X` hexadecimal, and `0b`/`0B`
binary.

Clang expands its response files when producing the trace. The SDK expands any
remaining lld response files, including nested `@file` references, using LLVM's
POSIX response-file tokenization rules. Expansion uses an iterative work stack,
not a nesting cutoff: both drivers inspect chains accepted by LLVM and reject
missing or recursive response files before the real link. To bound hostile or
accidental input, they also reject an expansion after 4,096 file expansions,
1,048,576 examined tokens, or 64 MiB of decoded response text. These are
explicit resource limits; exhausting one never falls back to the 8 MiB floor.
This keeps quoted or escaped paths distinct from linker options and prevents
object filenames containing `stack-size=` from changing the stack. Bare
`stack-size=<bytes>` tokens, `-z=stack-size=<bytes>`, and options after `--` are
not stack requests. Response-file contents are never rewritten.
The Node-hosted SDK accepts LLVM's UTF-8, UTF-16LE-BOM, and UTF-16BE-BOM
response encodings. The Kandelo-native Bash driver accepts UTF-8 response files
and rejects either UTF-16 BOM before compiling or linking: Bash variables cannot
retain UTF-16's embedded NUL bytes, and the packaged SDK does not declare a
transcoding tool. Generate UTF-8 response files when building inside Kandelo.
Invalid spellings stay visible to LLVM so it can reject them; a valid stack
larger than the SDK's fixed 1 GiB executable-memory maximum fails in the driver
instead of being silently replaced by the floor. Smaller legacy requests
therefore still receive 8 MiB, while programs such as SpiderMonkey that
explicitly need 16 MiB retain that larger reservation. Changing the platform
floor or scanner requires updating both `sdk/kandelo/bin/wasm32posix-cc` and
`sdk/src/lib/flags.ts`.

### Files linked automatically

When linking an executable (not compile-only), the SDK adds:
- `libc/glue/channel_syscall.c` — syscall dispatcher
- `libc/glue/compiler_rt.c` — soft-float and 64-bit builtins
- `sysroot/lib/crt1.o` — C runtime startup
- `sysroot/lib/libc.a` — musl libc

### Sysroot platform libraries

`scripts/build-musl.sh` also builds Kandelo's platform graphics shims into the
wasm32 sysroot:

| Library | pkg-config name | Purpose |
|---------|-----------------|---------|
| `sysroot/lib/libdrm.a` | `libdrm` | DRM/KMS wrapper entry points and ioctl packing |
| `sysroot/lib/libgbm.a` | `gbm` | GBM device and buffer-object helpers |
| `sysroot/lib/libEGL.a` | `egl` | EGL setup over `/dev/dri/renderD128` |
| `sysroot/lib/libGLESv2.a` | `glesv2` | GLES2/3 command-buffer encoder |

Programs should reference these through `wasm32posix-pkg-config`, for example:

```bash
wasm32posix-cc -D_DEFAULT_SOURCE \
  $(wasm32posix-pkg-config --cflags libdrm gbm egl glesv2) \
  app.c \
  $(wasm32posix-pkg-config --libs gbm libdrm egl glesv2) \
  -lm -o app.wasm
```

These libraries are part of the sysroot contract. They are not standalone
package dependencies and they are not outputs of the kernel package. A package
that links against them should declare the package's resulting executable or
VFS image as its output, and include the relevant sysroot/glue sources and
build scripts in `build.toml.inputs` so binary cache keys change when the
library ABI or implementation changes.

### Pthread slot limit

Executable builds also declare the process's pthread concurrency limit through the exported `__wasm_posix_thread_slots` function:

- `--kandelo-thread-slots=N` or `--wasm-posix-thread-slots=N` emits an explicit declaration. `N` may be `-1` to use the host default, `0` to allow no pthreads, or a positive exact concurrent pthread count.
- If the flag is omitted, the SDK emits `0` only when it can conservatively prove the link has no thread creation, dynamic libraries, `dlopen`, or uncertain runtime pthread use.
- Otherwise the SDK emits `-1`, so the host uses its configured default. The built-in default is 1024, an intentionally arbitrary high limit meant to avoid pthread availability problems for most programs now that slots are reserved on demand. Hosts can lower or raise it by creating the kernel worker with `defaultThreadSlots`.

The count is a resource limit, not a static memory slab reservation. The host dynamically reserves each four-page pthread control slot when `pthread_create()` succeeds and reuses exited slots within the same process.

### Flags silently ignored

These flags are common in build systems but irrelevant for Wasm:
- `-lpthread` (pthread symbols are provided by musl's `libc.a`)
- `-fPIE`, `-pie` (no position-independent executables in Wasm)
- `-lrt`, `-lresolv`, `-lm`, `-lcrypt`, `-lutil` (all in musl libc.a)
- `-rdynamic`, `-Wl,-Bsymbolic`
- `-Wl,-rpath,*`, `-Wl,-soname,*`, `-Wl,--version-script*`

## Autoconf Projects

The compiler drivers preserve `-pthread` so Clang supplies its standard
thread-aware compilation semantics, including defining `_REENTRANT`. The
separate `-lpthread` link flag remains an accepted no-op because Kandelo's musl
provides pthread symbols through `libc.a`.

Use `wasm32posix-configure` to run `./configure` with the correct cross-compilation settings:

```bash
cd /path/to/project
wasm32posix-configure
make
```

This sets:
- `CC=wasm32posix-cc`
- `CXX=wasm32posix-c++`
- `AR=wasm32posix-ar`
- `RANLIB=wasm32posix-ranlib`
- `NM=wasm32posix-nm`
- `STRIP=wasm32posix-strip`
- `--host=wasm32-unknown-linux-musl`
- `--build` (auto-detected from host system)

The `--host` tuple describes Kandelo's musl userland to GNU build systems.
GNU `config.sub` only accepts musl when paired with a Linux kernel component,
so this is the canonical tuple that lets Autoconf and gnulib select musl ABI
and libc behavior. It is not the compiler code-generation triple and does not
promise a Linux kernel: `wasm32posix-cc` continues to invoke Clang with
`--target=wasm32-unknown-unknown`, and Kandelo's documented POSIX surface
remains authoritative.

The wrapper also loads `sdk/config.site`. That file is authoritative for
shared target facts that cross-compilation cannot discover reliably, including
functions present in the Kandelo musl sysroot and extension functions that are
absent from it. Keep package-specific runtime or semantic probe results in the
package recipe, but add reusable sysroot availability facts to `config.site`
instead of duplicating them across packages. An explicitly exported
`CONFIG_SITE` overrides the SDK default.

Dynamic loading is an important exception to link-only detection. Musl carries
weak `dlopen`/`dlsym` stubs that link but only report that dynamic loading is
unsupported. `config.site` therefore directs `AC_SEARCH_LIBS` checks for the
dlfcn API to `-ldl`; the SDK compiler wrapper interprets that library request
by linking Kandelo's functional Wasm dynamic-loading glue. A configure result
of `none required` for those searches would select the nonfunctional stubs.

### Example: building dash

```bash
cd /tmp
git clone https://git.kernel.org/pub/scm/utils/dash/dash.git
cd dash
autoreconf -i
wasm32posix-configure --enable-static
make
# Output: src/dash (Wasm binary)
```

## CMake Projects

For CMake, create a toolchain file:

```cmake
# wasm32-posix-toolchain.cmake
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(CMAKE_C_COMPILER wasm32posix-cc)
set(CMAKE_CXX_COMPILER wasm32posix-c++)
set(CMAKE_AR wasm32posix-ar)
set(CMAKE_RANLIB wasm32posix-ranlib)

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
```

Then:

```bash
cmake -B build -DCMAKE_TOOLCHAIN_FILE=wasm32-posix-toolchain.cmake
cmake --build build
```

### Example: building Redis

```bash
cd /tmp
curl -LO https://github.com/redis/redis/archive/7.2.7.tar.gz
tar xzf 7.2.7.tar.gz
cd redis-7.2.7

# Redis uses plain Makefile, not CMake
make CC=wasm32posix-cc AR=wasm32posix-ar RANLIB=wasm32posix-ranlib \
     MALLOC=libc SERVER_CFLAGS=
# Then run `wasm-fork-instrument` on the linked output (see "Fork
# instrumentation" below). No special LDFLAGS are needed — the tool
# auto-discovers fork-path functions; there's no onlylist to pass.
```

See `packages/registry/redis/build-redis.sh` for the complete build script.

## Fork instrumentation (`wasm-fork-instrument`)

Programs that call `fork()` or fork-like APIs need the in-tree
`wasm-fork-instrument` tool to save/restore the Wasm call stack across fork.
Fork-like APIs include `vfork()`, `_Fork()`, shell pipelines, command
substitution, `system()`, `popen()`, and helper processes implemented through
fork.

This step is mandatory for fork-using programs. Do not use Binaryen Asyncify,
do not tolerate missing instrumentation, and do not publish binaries that
export legacy `asyncify_*` symbols.

```bash
# Compile normally
wasm32posix-cc program.c -o program.wasm

# (Optional) shrink with wasm-opt -O2 first; must run BEFORE the instrument
# step since fork-instrument hardcodes mutable-global offsets.
wasm-opt -O2 program.wasm -o program.wasm

# Apply fork instrumentation. Auto-discovers fork-path functions via
# call-graph analysis from the kernel.kernel_fork import — no onlylist
# file needed. The wrapper builds the tool on demand if tools/bin is absent.
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" program.wasm -o program.wasm.instr
mv program.wasm.instr program.wasm
```

The tool emits five `wpk_fork_*` exports that the host runtime drives during
fork. Programs that don't use fork can skip this step entirely, but a program
that reaches `kernel_fork` without complete `wpk_fork_*` instrumentation is
invalid.

See [`docs/fork-instrumentation.md`](fork-instrumentation.md) for the
exported ABI, save-buffer format, and the dispatch-scheme decisions.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `WASM_POSIX_LLVM_DIR` | Path to LLVM bin directory |
| `WASM_POSIX_SYSROOT` | Override sysroot path (default: `<repo>/sysroot`) |
| `WASM_POSIX_GLUE_DIR` | Override glue directory (default: `<repo>/libc/glue`) |

## Running Programs

### Node.js

```bash
# Using the example runner (handles fork, exec, threads)
npx tsx examples/run-example.ts program.wasm [args...]

# Or use the host API directly
node --experimental-strip-types your-script.ts
```

### Browser

See the [Porting Guide](porting-guide.md) for preparing browser-facing package images.

## Tips

- **Use `-pthread` when the build requires it**: The SDK forwards it to Clang
  for standard compiler semantics such as `_REENTRANT`; pthread symbols still
  come from musl's `libc.a`.
- **Use `-O2` or `-Os`**: Unoptimized Wasm is significantly slower and larger.
- **Check build script examples**: `packages/registry/` contains complete build scripts for 12 real-world libraries including autoconf, CMake, and plain Makefile projects.
- **For fork support**: Run `scripts/run-wasm-fork-instrument.sh` as the final
  post-link step. Without complete `wpk_fork_*` exports, fork-using programs
  are invalid.
- **For DRM/KMS/EGL/GLES programs**: Rebuild the wasm32 sysroot with
  `scripts/dev-shell.sh bash scripts/build-musl.sh` if `libdrm`, `libgbm`,
  `libEGL`, or `libGLESv2` is missing. `build.sh` does not rebuild musl or
  these sysroot libraries.
- **Memory limit**: Default max memory is 1GB (16384 pages). Processes start with a smaller computed shared memory and grow on demand up to `maxMemoryPages`.
