#!/usr/bin/env bash
#
# Build libkwl.a (a tiny Wayland toolkit over libwayland-client) and install
# it into a wasm32 sysroot. Like wpkdraw, libkwl is in-tree source with no
# upstream tarball, so it is NOT a `cargo xtask build-deps` package (the
# resolver only walks packages/registry/). It is built inline by
# scripts/build-programs.sh, and can also be run by hand:
#
#     CC=/path/to/clang AR=/path/to/llvm-ar \
#     XDG_SHELL_INCLUDE=/path/to/wlcompositor-gen ./build.sh <sysroot>
#
# XDG_SHELL_INCLUDE must point at the directory holding the generated
# xdg-shell-client-protocol.h (scripts/build-programs.sh generates it into
# local-binaries/wlcompositor-gen with wayland-scanner). The wayland /
# xkbcommon / gbm / wpkdraw headers resolve off <sysroot>/include.
#
# It installs:
#     <sysroot>/lib/libkwl.a
#     <sysroot>/include/kwl.h
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSROOT="${1:?usage: build.sh <sysroot>}"
CC="${CC:-clang}"
AR="${AR:-llvm-ar}"
XDG_SHELL_INCLUDE="${XDG_SHELL_INCLUDE:?set XDG_SHELL_INCLUDE to the wlcompositor-gen dir}"

WORK="$SRC_ROOT/build"
mkdir -p "$WORK"

# Compile flags for a wasm32 static archive — same shape as wpkdraw's
# build.sh (no link flags; these .o files archive into libkwl.a and get
# linked into the consumer by build-programs.sh). -matomics/-mbulk-memory
# keep them ABI-compatible with the threaded final link.
CFLAGS=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -I"$SRC_ROOT/include"
    -I"$SYSROOT/include"
    -I"$XDG_SHELL_INCLUDE"
)

echo "  Compiling libkwl (kwl.c)..."
"$CC" "${CFLAGS[@]}" -c "$SRC_ROOT/src/kwl.c" -o "$WORK/kwl.o"

mkdir -p "$SYSROOT/lib" "$SYSROOT/include"
"$AR" rcs "$SYSROOT/lib/libkwl.a" "$WORK/kwl.o"
cp "$SRC_ROOT/include/kwl.h" "$SYSROOT/include/kwl.h"

echo "  libkwl installed: $SYSROOT/lib/libkwl.a ($(wc -c < "$SYSROOT/lib/libkwl.a") bytes)"
