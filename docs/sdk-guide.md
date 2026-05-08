# SDK Guide

The wasm-posix-sdk provides a cross-compilation toolchain for building C/C++ programs that run on Kandelo. It wraps LLVM tools with the correct flags for the `wasm32-unknown-unknown` target and links against the musl libc sysroot.

## Installation

### Prerequisites

1. **LLVM 21+** with clang and wasm-ld:
   - macOS: `brew install llvm`
   - Ubuntu: `apt install llvm clang lld`
   - Or use the Nix dev shell (`nix develop` from the repo root) — provides
     LLVM 21 plus the rest of the toolchain, no per-tool install needed.
     See the README's "Using Nix" section.
2. **musl sysroot** built from this repo:
   ```bash
   git submodule update --init musl
   bash scripts/build-musl.sh
   ```
3. **Kernel built**:
   ```bash
   bash build.sh
   ```

### Install the SDK

```bash
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
the libcxx package (`examples/libs/libcxx/`) and resolved automatically
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

### Building static libraries

```bash
wasm32posix-cc -c lib_a.c -o lib_a.o
wasm32posix-cc -c lib_b.c -o lib_b.o
wasm32posix-ar rcs libfoo.a lib_a.o lib_b.o
wasm32posix-cc main.c -L. -lfoo -o program.wasm
```

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
-mllvm -wasm-use-legacy-eh=true    # Use legacy exception handling (Asyncify-compatible)
-fno-exceptions                    # No C++ exceptions
-fno-trapping-math                 # Non-trapping FP (Wasm requirement)
--sysroot=<path>                   # musl sysroot
```

### Linker flags injected automatically

```
-nostdlib                          # Don't use system libc
-Wl,--entry=_start                 # Entry point
-Wl,--import-memory                # Memory provided by host
-Wl,--shared-memory                # Enable SharedArrayBuffer
-Wl,--max-memory=1073741824        # 1GB max memory
-Wl,--global-base=1114112          # Data segment start
-Wl,--allow-undefined              # Host imports are resolved at load time
-Wl,--export-table                 # Export function table (for dlopen)
-Wl,--export=__stack_pointer       # Required for fork/thread support
-Wl,--export=__tls_base            # Required for TLS
-Wl,--export=__wasm_init_tls       # TLS initialization
```

### Files linked automatically

When linking an executable (not compile-only), the SDK adds:
- `glue/channel_syscall.c` — syscall dispatcher
- `glue/compiler_rt.c` — soft-float and 64-bit builtins
- `sysroot/lib/crt1.o` — C runtime startup
- `sysroot/lib/libc.a` — musl libc

### Flags silently ignored

These flags are common in build systems but irrelevant for Wasm:
- `-pthread`, `-lpthread` (threads are host-managed)
- `-fPIE`, `-pie` (no position-independent executables in Wasm)
- `-lrt`, `-lresolv`, `-lm`, `-lcrypt`, `-lutil` (all in musl libc.a)
- `-rdynamic`, `-Wl,-Bsymbolic`
- `-Wl,-rpath,*`, `-Wl,-soname,*`, `-Wl,--version-script*`

## Autoconf Projects

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
- `--host=wasm32-unknown-none`
- `--build` (auto-detected from host system)

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
     MALLOC=libc SERVER_CFLAGS= \
     LDFLAGS="-Wl,--export=__asyncify_data,--export=asyncify_start_unwind,..."
```

See `examples/libs/redis/build-redis.sh` for the complete build script.

## Asyncify (fork support)

Programs that call `fork()`, `posix_spawn()`, or `system()` need Binaryen's Asyncify post-processing to save/restore the Wasm call stack:

```bash
# Compile normally
wasm32posix-cc program.c -o program.wasm

# Post-process with wasm-opt
wasm-opt --asyncify \
  --asyncify-imports "env.channel_syscall" \
  --pass-arg=asyncify-ignore-indirect \
  -O2 \
  program.wasm -o program.wasm
```

The `--asyncify-imports` flag tells Asyncify which import triggers the unwind (the channel syscall function). Programs that don't use fork don't need this step.

For large programs, use `--asyncify-onlylist` to restrict instrumentation to only the functions on the fork call path. This dramatically reduces binary size and stack depth:

```bash
wasm-opt --asyncify \
  --asyncify-imports "env.channel_syscall" \
  --asyncify-onlylist @onlylist.txt \
  --pass-arg=asyncify-ignore-indirect \
  -O2 \
  program.wasm -o program.wasm
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `WASM_POSIX_LLVM_DIR` | Path to LLVM bin directory |
| `WASM_POSIX_SYSROOT` | Override sysroot path (default: `<repo>/sysroot`) |
| `WASM_POSIX_GLUE_DIR` | Override glue directory (default: `<repo>/glue`) |

## Running Programs

### Node.js

```bash
# Using the example runner (handles fork, exec, threads)
npx tsx examples/run-example.ts program.wasm [args...]

# Or use the host API directly
node --experimental-strip-types your-script.ts
```

### Browser

See the [Porting Guide](porting-guide.md) for creating browser demos.

## Tips

- **Don't add `-pthread`**: Thread creation is host-managed via `clone()`. The SDK silently ignores `-pthread`.
- **Use `-O2` or `-Os`**: Unoptimized Wasm is significantly slower and larger.
- **Check build script examples**: `examples/libs/` contains complete build scripts for 12 real-world libraries including autoconf, CMake, and plain Makefile projects.
- **For fork support**: Always apply Asyncify post-processing. Without it, `fork()` will fail.
- **Memory limit**: Default max memory is 1GB (16384 pages). For multi-process demos, consider reducing `maxMemoryPages` to avoid exhausting browser memory.
