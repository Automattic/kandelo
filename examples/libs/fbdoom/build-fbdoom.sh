#!/usr/bin/env bash
# Cross-compile maximevince/fbDOOM for the wasm-posix-kernel using
# wasm32posix-cc. The fbdev frontend writes BGRA32 pixels into the
# framebuffer mmap; the canvas renderer (host/src/framebuffer/canvas-renderer.ts)
# consumes them.
#
# Output: examples/libs/fbdoom/fbdoom.wasm
#
# Usage: bash examples/libs/fbdoom/build-fbdoom.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
SRC="$HERE/fbdoom-src"

if [ ! -d "$SRC" ]; then
    echo "==> Cloning maximevince/fbDOOM..."
    git clone --depth 1 https://github.com/maximevince/fbDOOM "$SRC"
fi

cd "$SRC/fbdoom"

echo "==> Cleaning previous build..."
make clean || true

echo "==> Cross-compiling fbdoom (wasm32, NOSDL=1)..."
# fbDOOM's own Makefile already wires NOSDL=1 to the framebuffer + null
# audio frontend; we just override the toolchain.
#
# LIBS="-lm" — wasm32posix-cc auto-injects channel_syscall.c plus the
# musl libc.a; passing -lc explicitly (the upstream Makefile default)
# would cause duplicate-symbol errors for fork / _Fork / __syscall_cp.
# We keep -lm because the SDK doesn't auto-link libm.
make CC=wasm32posix-cc \
     LD=wasm32posix-cc \
     CFLAGS="-O2 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE" \
     LDFLAGS="" \
     LIBS="-lm" \
     NOSDL=1

cp fbdoom "$HERE/fbdoom.wasm"

# fbDOOM doesn't fork — no asyncify / wasm-fork-instrument step needed.
# (vs other ports here: dash forks via popen/system, so its build-dash.sh
# runs `wasm-opt --asyncify` for the fork path.)

ls -la "$HERE/fbdoom.wasm"
echo "==> fbdoom.wasm built."
