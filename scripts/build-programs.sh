#!/bin/bash
set -euo pipefail

# Build user programs (programs/*.c) into local-binaries/programs/.
# The resolver (host/src/binary-resolver.ts) prefers local-binaries/
# over binaries/, so locally-built binaries automatically override
# whatever the fetcher placed under `binaries/`.
# Uses the same toolchain and flags as libc-test builds.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
# Per-arch output dirs match the layout the resolver's
# `place_binaries_symlinks` writes:
# binaries/programs/<arch>/ and local-binaries/programs/<arch>/.
# wasm32 and wasm64 builds share program names (e.g. hello64.wasm)
# so they MUST live in separate trees — a flat OUT_DIR would
# last-write-wins across arches.
OUT_DIR_32="$REPO_ROOT/local-binaries/programs/wasm32"
OUT_DIR_64="$REPO_ROOT/local-binaries/programs/wasm64"
mkdir -p "$OUT_DIR_32" "$OUT_DIR_64"

# Auto-detect LLVM (same logic as SDK / run-libc-tests.sh)
find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    local brew_prefix
    if brew_prefix=$(brew --prefix llvm 2>/dev/null) && [ -d "$brew_prefix/bin" ]; then
        echo "$brew_prefix/bin"; return
    fi
    for v in 21 20 19 18 17 16 15; do
        if [ -x "/usr/bin/clang-$v" ]; then echo "/usr/bin"; return; fi
    done
    if command -v clang >/dev/null 2>&1; then echo "$(dirname "$(command -v clang)")"; return; fi
    echo "Error: LLVM/clang not found. Set LLVM_BIN or install LLVM." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi

CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=true
)

LINK_FLAGS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$SYSROOT/lib/crt1.o"
    "$SYSROOT/lib/libc.a"
    -Wl,--entry=_start
    -Wl,--export=_start
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--table-base=3
    -Wl,--export-table
    -Wl,--growable-table
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__tls_base
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__stack_pointer
    -Wl,--export=__wasm_thread_init
    -Wl,--export=__abi_version
)

ASYNCIFY_IMPORTS="kernel.kernel_fork"

build_program() {
    local src="$1"
    local out_dir="$2"
    local name
    name=$(basename "$src" .c)
    local wasm="$out_dir/${name}.wasm"

    echo "  Compiling $name..."
    "$CC" "${CFLAGS[@]}" "$src" "${LINK_FLAGS[@]}" -o "$wasm"

    # Asyncify for fork/exec support
    if [ -n "$WASM_OPT" ]; then
        "$WASM_OPT" --asyncify \
            --pass-arg="asyncify-imports@${ASYNCIFY_IMPORTS}" \
            "$wasm" -o "$wasm" 2>/dev/null || true
    fi
}

# Build a C++ program via the SDK's wasm32posix-c++ wrapper. The SDK
# injects the toolchain's standard compile + link flags, the channel
# syscall glue, the C++ runtime stubs (cxxrt.c), and the sysroot path.
# The default include search includes the sysroot's libc++ headers so
# no extra -isystem is needed; we only have to supply -lc++ / -lc++abi
# at link time.
build_cpp_program() {
    local src="$1"
    local out_dir="$2"
    local name
    name=$(basename "$src" .cpp)
    local wasm="$out_dir/${name}.wasm"

    echo "  Compiling $name (C++)..."
    # -fwasm-exceptions is required for clang to lower C++ try/catch
    # to wasm-EH `try`/`catch` instructions. Without it clang emits
    # `__cxa_throw; unreachable` and DCEs the catch handlers, so the
    # whole exception-propagation chain (libunwind + libc++abi) never
    # runs.
    wasm32posix-c++ \
        -O2 \
        -fwasm-exceptions \
        "$src" \
        -lc++ -lc++abi \
        -o "$wasm"

    # Asyncify for fork/exec support. Harmless when no kernel.kernel_fork
    # import is present (the pass becomes a no-op).
    if [ -n "$WASM_OPT" ]; then
        "$WASM_OPT" --asyncify \
            --pass-arg="asyncify-imports@${ASYNCIFY_IMPORTS}" \
            "$wasm" -o "$wasm" 2>/dev/null || true
    fi
}

# Resolve libcxx and symlink its outputs into the sysroot if there are
# any .cpp programs to build. Skip the resolver entirely when libc++.a
# is already present so repeat runs are fast.
if ls "$REPO_ROOT/programs/"*.cpp >/dev/null 2>&1; then
    if [ ! -f "$SYSROOT/lib/libc++.a" ]; then
        echo "==> Resolving libcxx for C++ programs..."
        HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
        (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps resolve libcxx >/dev/null)
        LIBCXX_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TRIPLE" --quiet -- build-deps path libcxx)"
        ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
        ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
        mkdir -p "$SYSROOT/include/c++"
        rm -rf "$SYSROOT/include/c++/v1"
        ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"
    fi
fi

echo "Building user programs..."
for src in "$REPO_ROOT/programs/"*.c; do
    [ -f "$src" ] || continue
    # Skip sh.c — host/wasm/sh.wasm is the pre-built full-featured dash binary.
    # The minimal sh.c was a placeholder; building it overwrites dash with a
    # shell that lacks eval and other builtins needed by wordexp/popen.
    [ "$(basename "$src")" = "sh.c" ] && continue
    # Skip hello64.c — built separately with wasm64 toolchain below
    [ "$(basename "$src")" = "hello64.c" ] && continue
    build_program "$src" "$OUT_DIR_32"
done

for src in "$REPO_ROOT/programs/"*.cpp; do
    [ -f "$src" ] || continue
    build_cpp_program "$src" "$OUT_DIR_32"
done

echo "Building example programs..."
for src in "$REPO_ROOT/examples/"*.c; do
    [ -f "$src" ] || continue
    build_program "$src" "$REPO_ROOT/examples"
done

echo "Building benchmark programs..."
BENCH_OUT_DIR="$REPO_ROOT/benchmarks/wasm"
mkdir -p "$BENCH_OUT_DIR"
for src in "$REPO_ROOT/benchmarks/programs/"*.c; do
    [ -f "$src" ] || continue
    build_program "$src" "$BENCH_OUT_DIR"
done

# Build wasm64 programs if sysroot64 exists
SYSROOT64="$REPO_ROOT/sysroot64"
if [ -f "$SYSROOT64/lib/libc.a" ]; then
    echo "Building wasm64 programs..."

    CFLAGS64=(
        --target=wasm64-unknown-unknown
        --sysroot="$SYSROOT64"
        -nostdlib
        -O2
        -matomics -mbulk-memory
        -fno-trapping-math
        -mllvm -wasm-enable-sjlj
        -mllvm -wasm-use-legacy-eh=true
    )

    LINK_FLAGS64=(
        "$GLUE_DIR/channel_syscall.c"
        "$GLUE_DIR/compiler_rt.c"
        "$SYSROOT64/lib/crt1.o"
        "$SYSROOT64/lib/libc.a"
        -Wl,--entry=_start
        -Wl,--export=_start
        -Wl,--import-memory
        -Wl,--shared-memory
        -Wl,--max-memory=1073741824
        -Wl,--allow-undefined
        -Wl,--table-base=3
        -Wl,--export-table
        -Wl,--growable-table
        -Wl,--export=__wasm_init_tls
        -Wl,--export=__tls_base
        -Wl,--export=__tls_size
        -Wl,--export=__tls_align
        -Wl,--export=__stack_pointer
        -Wl,--export=__wasm_thread_init
    )

    for src in "$REPO_ROOT/programs/"hello64.c; do
        [ -f "$src" ] || continue
        local_name=$(basename "$src" .c)
        echo "  Compiling $local_name (wasm64)..."
        "$CC" "${CFLAGS64[@]}" "$src" "${LINK_FLAGS64[@]}" -o "$OUT_DIR_64/${local_name}.wasm"
    done
fi

echo "Programs built."
