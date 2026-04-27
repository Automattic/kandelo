#!/usr/bin/env bash
# Build the in-tree lsof.c (a small /proc reader) for wasm32-posix-kernel.
# Source: examples/lsof.c.  Not the upstream lsof — this is a minimal
# implementation tailored to this kernel's procfs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC="$REPO_ROOT/examples/lsof.c"
OUT_BIN="$SCRIPT_DIR/lsof.wasm"

if [ ! -f "$SRC" ]; then
    echo "ERROR: source not found at $SRC" >&2
    exit 1
fi

# Match scripts/build-programs.sh CC + flags so the resulting wasm is
# binary-compatible with everything else in the release.
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"

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

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run scripts/build-musl.sh first." >&2
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

echo "==> Building lsof.wasm from $SRC"
"$CC" "${CFLAGS[@]}" "$SRC" "${LINK_FLAGS[@]}" -o "$OUT_BIN"

if [ -n "$WASM_OPT" ]; then
    "$WASM_OPT" --asyncify \
        --pass-arg="asyncify-imports@kernel.kernel_fork" \
        -O2 "$OUT_BIN" -o "$OUT_BIN"
fi

ls -lh "$OUT_BIN"
echo "==> lsof built successfully!"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lsof "$OUT_BIN"
