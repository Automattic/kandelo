#!/bin/bash
set -euo pipefail

# Build dlopen example: shared library (.so) + main program
#
# Usage: bash examples/dlopen/build.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# WHY: the SDK resolves the sysroot and glue dir by walking up from
# process.cwd() (findSysroot/findGlueDir via projectRootOrSdk,
# sdk/src/lib/toolchain.ts:13-31,112-131), not from this script's location.
# Invoked with a cwd inside a different kandelo worktree it would link against
# THAT worktree's sysroot while the check below validated this one. Pin the
# cwd so both agree.
cd "$REPO_ROOT"
SYSROOT="$REPO_ROOT/sysroot"

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

# The SDK owns both link contracts this example needs: linkFlags() for the
# executable and SHARED_LINK_FLAGS for the side module (sdk/src/lib/flags.ts).
# This script used to carry its own copy of each, and the executable copy had
# already drifted -- it reserved wasm-ld's ~64 KiB default shadow stack instead
# of the SDK's 8 MiB, and exported no __abi_version. An example is the first
# thing a reader copies, so it must show the supported way to build, not a
# private one.
#
# Absolute path, never a bare `wasm32posix-cc`: a bare name resolves through
# PATH and can pick up a different worktree's SDK.
#
# Deliberately NOT named CC. That name is already exported in the dev shell,
# and bash keeps the export attribute when you assign to an exported name, so
# the value would reach every child process this script starts.
WASM32_CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi

echo "=== Building dlopen example ==="

# 1. Build shared library (hello-lib.so)
#
# `-shared -fPIC` selects the SDK's side-module link: it supplies -nostdlib,
# --experimental-pic, --shared, --shared-memory, --export-all and
# --allow-undefined (SHARED_LINK_FLAGS), so no separate wasm-ld step and no
# intermediate object are needed.
echo "  Compiling hello-lib.so..."
"$WASM32_CC" -shared -fPIC -O2 \
    "$SCRIPT_DIR/hello-lib.c" -o "$SCRIPT_DIR/hello-lib.so"

# 2. Build main program (main.wasm) with dlopen support
#
# `-ldl` is how the SDK spells the dlopen glue this program needs; the driver
# adds libc/glue/dlopen.c to the link for it (parseArgs/linkDl,
# sdk/src/bin/cc.ts). Everything else the old LINK_FLAGS listed -- the syscall
# glue, compiler_rt.c, crt1.o, libc.a, -nostdlib and every -Wl, flag -- the
# driver supplies too, along with the target, the sysroot and the codegen
# flags. -O2 is the only compile choice left here.
echo "  Compiling main.wasm..."
"$WASM32_CC" -O2 -ldl "$SCRIPT_DIR/main.c" -o "$SCRIPT_DIR/main.wasm"

echo "=== Build complete ==="
echo "  Library: $SCRIPT_DIR/hello-lib.so"
echo "  Program: $SCRIPT_DIR/main.wasm"
echo ""
echo "Run with:"
echo "  npx tsx examples/dlopen/serve.ts"
