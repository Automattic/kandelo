#!/bin/bash
set -euo pipefail

# Build user programs (programs/*.c) into local-binaries/programs/.
# The resolver (host/src/binary-resolver.ts) prefers local-binaries/
# over binaries/, so locally-built binaries automatically override
# whatever the fetcher placed under `binaries/`.
# Uses the same toolchain and flags as libc-test builds.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/libc/glue"
# Per-arch output dirs match the layout the resolver's
# `place_binaries_symlinks` writes:
# binaries/programs/<arch>/ and local-binaries/programs/<arch>/.
# wasm32 and wasm64 builds share program names (e.g. hello64.wasm)
# so they MUST live in separate trees — a flat OUT_DIR would
# last-write-wins across arches.
OUT_DIR_32="$REPO_ROOT/local-binaries/programs/wasm32"
OUT_DIR_64="$REPO_ROOT/local-binaries/programs/wasm64"
mkdir -p "$OUT_DIR_32" "$OUT_DIR_64"

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ] && [ -x "$LLVM_BIN/clang" ]; then
        echo "$LLVM_BIN"
        return
    fi
    if [ -n "${LLVM_PREFIX:-}" ] && [ -x "$LLVM_PREFIX/bin/clang" ]; then
        echo "$LLVM_PREFIX/bin"
        return
    fi
    if command -v clang >/dev/null 2>&1; then
        dirname "$(command -v clang)"
        return
    fi
    echo "Error: LLVM/clang not found. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
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
    -mllvm -wasm-use-legacy-eh=false
)

LINK_PRE_LIBS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$SYSROOT/lib/crt1.o"
)

# libc.a + linker flags. Per-program extra archives (libdrm.a, libgbm.a,
# libEGL.a, libGLESv2.a) are spliced BEFORE libc.a so the stubs'
# internal references (mmap, ioctl, calloc, …) resolve in a single
# linker pass.
LINK_POST_LIBS=(
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

# Fork support comes from wasm-fork-instrument. The tool auto-discovers
# fork-path functions via call-graph analysis from `kernel.kernel_fork`;
# no onlylist is needed.
# See docs/fork-instrumentation.md.
FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

build_program() {
    local src="$1"
    local out_dir="$2"
    shift 2
    local extra_libs=("$@")
    local name
    name=$(basename "$src" .c)
    local wasm="$out_dir/${name}.wasm"

    # Auto-append GL stubs when the source pulls in EGL/GLES headers.
    # Static linking won't pick symbols out of libEGL.a / libGLESv2.a
    # unless the program references them, so this is a no-op for
    # non-GL programs even if the archives are appended.
    if grep -qE '^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"](EGL|GLES[23]?)/' "$src" 2>/dev/null; then
        if [ -f "$SYSROOT/lib/libEGL.a" ] && [ -f "$SYSROOT/lib/libGLESv2.a" ]; then
            extra_libs+=("$SYSROOT/lib/libEGL.a" "$SYSROOT/lib/libGLESv2.a")
        else
            echo "  Skipping $name: GL archives missing — run scripts/build-gles-stubs.sh." >&2
            return 0
        fi
    fi

    echo "  Compiling $name..."
    # Bash 3.2 (macOS system bash) under `set -u` treats expansion of
    # an empty array as unbound; the `${arr[@]+...}` guard suppresses
    # that when extra_libs is empty.
    "$CC" "${CFLAGS[@]}" "$src" \
        "${LINK_PRE_LIBS[@]}" \
        ${extra_libs[@]+"${extra_libs[@]}"} \
        "${LINK_POST_LIBS[@]}" \
        -o "$wasm"

    # Apply fork instrumentation if the program uses fork. The tool is a
    # no-op for modules without `kernel.kernel_fork`, so it's safe to run
    # unconditionally on every program. Programs without fork stay
    # byte-identical except for a small ABI metadata section the tool
    # always emits (see runtime::inject_runtime).
    "$FORK_INSTRUMENT" "$wasm" -o "$wasm.instr"
    mv "$wasm.instr" "$wasm"
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

    # Phase 7: fork support comes from wasm-fork-instrument. The tool is
    # a no-op for modules without `kernel.kernel_fork`, so it's safe to
    # run unconditionally — programs without fork stay byte-identical
    # except for the ABI metadata section.
    "$FORK_INSTRUMENT" "$wasm" -o "$wasm.instr"
    mv "$wasm.instr" "$wasm"
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
    # Skip hello64.c — built separately with wasm64 toolchain below
    [ "$(basename "$src")" = "hello64.c" ] && continue
    # DRI programs link against the libdrm / libgbm shims
    # (sysroot/lib/libdrm.a, libgbm.a). EGL/GLES2 stubs are picked up
    # by build_program's header-based auto-detection.
    case "$(basename "$src")" in
        modeset.c|dri-modeset.c|dumb_roundtrip.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libgbm.a" "$SYSROOT/lib/libdrm.a"
            ;;
        libdrm-kms-smoke.c)
            build_program "$src" "$OUT_DIR_32" \
                "$SYSROOT/lib/libdrm.a"
            ;;
        *)
            build_program "$src" "$OUT_DIR_32"
            ;;
    esac
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
        -mllvm -wasm-use-legacy-eh=false
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
        -Wl,--export=__abi_version
    )

    for src in \
        "$REPO_ROOT/programs/"hello64.c \
        "$REPO_ROOT/programs/"ifhwaddr.c; do
        [ -f "$src" ] || continue
        local_name=$(basename "$src" .c)
        echo "  Compiling $local_name (wasm64)..."
        "$CC" "${CFLAGS64[@]}" "$src" "${LINK_FLAGS64[@]}" -o "$OUT_DIR_64/${local_name}.wasm"
    done

    # Keep the memory64 wait-lifecycle browser fixture on the same owned build
    # path as its wasm32 counterpart. Vitest also compiles this file in global
    # setup, but browser-only and packed CI workspaces must not depend on that
    # earlier runner having left a generated artifact behind. This fixture
    # deliberately uses posix_spawn rather than fork because fork rewind
    # instrumentation is currently a wasm32 artifact contract.
    wait_lifecycle_src="$REPO_ROOT/examples/wait_lifecycle_test.c"
    if [ -f "$wait_lifecycle_src" ]; then
        echo "  Compiling wait_lifecycle_test (wasm64)..."
        "$CC" "${CFLAGS64[@]}" "$wait_lifecycle_src" "${LINK_FLAGS64[@]}" \
            -o "$REPO_ROOT/examples/wait_lifecycle_test.wasm64.wasm"
    fi
fi

echo "Programs built."
