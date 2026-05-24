# SDK / Build System Wrapper Design

**Date:** 2026-03-14
**Status:** Approved

## Goal

General-purpose SDK for compiling C/C++ programs to target Kandelo. Supports autoconf-based projects (like PHP) out of the box. Written in TypeScript, run via Node.js native type stripping.

## CLI Tools

| Tool | Purpose |
|------|---------|
| `wasm32posix-cc` | Clang wrapper for compiling + linking C |
| `wasm32posix-c++` | Clang++ wrapper for C++ |
| `wasm32posix-ar` | Wraps `llvm-ar` |
| `wasm32posix-ranlib` | Wraps `llvm-ranlib` |
| `wasm32posix-nm` | Wraps `llvm-nm` |
| `wasm32posix-strip` | No-op (Wasm stripping handled by linker) |
| `wasm32posix-pkg-config` | Wraps `pkg-config` with sysroot-aware defaults |
| `wasm32posix-configure` | Runs `./configure` with all env vars preset |

All tools are thin TypeScript scripts that auto-detect the LLVM toolchain, inject required flags, and forward remaining arguments to the underlying tool.

## File Structure

```
sdk/
├── package.json          # bin entries point to src/bin/*.ts
├── tsconfig.json
└── src/
    ├── bin/
    │   ├── cc.ts             # wasm32posix-cc
    │   ├── c++.ts            # wasm32posix-c++
    │   ├── ar.ts             # wasm32posix-ar
    │   ├── ranlib.ts         # wasm32posix-ranlib
    │   ├── nm.ts             # wasm32posix-nm
    │   ├── strip.ts          # wasm32posix-strip
    │   ├── pkg-config.ts     # wasm32posix-pkg-config
    │   └── configure.ts      # wasm32posix-configure
    └── lib/
        ├── toolchain.ts      # LLVM/sysroot/glue discovery
        ├── flags.ts          # Shared compiler/linker flag constants
        └── exec.ts           # Child process helpers
```

## CC Wrapper Modes

The cc wrapper handles three modes:

### Compile-only (`-c` flag present)
- Pass through to clang with `--target=wasm32-unknown-unknown --sysroot=... -matomics -mbulk-memory -fno-exceptions -fno-trapping-math`
- No glue or linker flags

### Link-only (input is `.o` files, no `-c`)
- Add glue objects: `syscall_glue.c`, `compiler_rt.c`, `crt1.o`
- Add `libc.a`
- Add linker flags: `--entry=_start`, `--export=_start`, `--import-memory`, `--shared-memory`, `--max-memory=1073741824`, `--allow-undefined`

### Compile + link (input is `.c` files, no `-c`)
- Both sets of flags combined

## Flag Handling

### Injected flags (always added)
- `--target=wasm32-unknown-unknown`
- `--sysroot=<path>`
- `-matomics -mbulk-memory`
- `-fno-exceptions -fno-trapping-math`

### Silently ignored flags
- Threading: `-pthread`, `-lpthread`
- Shared libs: `-fPIC`, `-fPIE`, `-pie`
- Dynamic linking: `-ldl`, `-lrt`, `-lresolv`, `-lm`, `-lcrypt`, `-lutil`
- Platform-specific: `-rdynamic`, `-Wl,-rpath,*`, `-Wl,-soname,*`, `-Wl,-Bsymbolic`

### Warn but continue
- `-shared`, `-dynamiclib` — emit warning, produce static library instead (dynamic linking support deferred)

### Passed through as-is
- Optimization: `-O*`, `-g`, `-DNDEBUG`
- Warnings: `-W*`
- Defines: `-D*`
- Includes: `-I*`
- Source files and object files
- `-c`, `-o`, `-E`, `-S`
- Any other unrecognized flags (let clang decide)

## LLVM Discovery

Checked in order:
1. `WASM_POSIX_LLVM_DIR` env var
2. `clang` on PATH (verify it supports `--target=wasm32-unknown-unknown`)
3. `/opt/homebrew/opt/llvm/bin` (macOS Homebrew)
4. `/usr/lib/llvm-*/bin` (Debian/Ubuntu, pick highest version)

If none found, error with install instructions.

## Sysroot Discovery

1. `WASM_POSIX_SYSROOT` env var
2. Resolve relative to SDK: `path.resolve(__dirname, '../../sysroot')`

If `sysroot/lib/libc.a` doesn't exist, error telling user to run `scripts/build-musl.sh`.

## Glue Discovery

1. `WASM_POSIX_GLUE_DIR` env var
2. Resolve relative to SDK: `path.resolve(__dirname, '../../glue')`

## Configure Helper

`wasm32posix-configure` runs:

```
./configure --host=wasm32-unknown-none --prefix=/usr \
  CC=wasm32posix-cc \
  CXX=wasm32posix-c++ \
  AR=wasm32posix-ar \
  RANLIB=wasm32posix-ranlib \
  NM=wasm32posix-nm \
  STRIP=wasm32posix-strip \
  PKG_CONFIG=wasm32posix-pkg-config \
  CFLAGS="" \
  LDFLAGS="" \
  "$@"
```

- `--host=wasm32-unknown-none` tells autoconf it's cross-compiling
- `--prefix=/usr` keeps install paths relative
- Forwards all extra user arguments
- Expects `wasm32posix-*` tools on PATH

## Deferred

- CMake toolchain file
- Meson cross-file
- npm global install / packaging
- LLVM download/bundling
- Automatic sysroot building
- Shared library / dynamic linking support

## Testing

- Unit tests: flag parsing, LLVM discovery logic
- Integration: compile a simple C program via `wasm32posix-cc`, run through kernel
- Integration: run `wasm32posix-configure` on a small autoconf project
