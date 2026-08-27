#!/usr/bin/env bash
#
# Build kandelo-sdk.zip for the browser shell demo.
#
# Packages the whole C/C++ toolchain — clang/wasm-ld/llvm-ar/llvm-ranlib/
# llvm-nm, the Clang resource headers, the wasm32 sysroot (libc + libc++),
# the SDK compiler-wrapper scripts, and the precompiled glue objects — into
# a single archive. The demo registers this as a lazy archive with mount
# prefix /usr/, so entries become /usr/lib/llvm/bin/clang,
# /usr/wasm32posix/sysroot/..., /usr/bin/cc, and so on. On first exec of cc
# (or clang), the whole archive is fetched and unpacked in one go.
#
# Usage:
#   build-kandelo-sdk-zip.sh <clang-dir> <libcxx-dir> <output.zip>
#
# <clang-dir> is the resolved `clang` package output directory (the 5 wasm
# binaries: clang.wasm, wasm-ld.wasm, llvm-ar.wasm, llvm-ranlib.wasm,
# llvm-nm.wasm). <libcxx-dir> is the resolved `libcxx` package output
# directory (lib/libc++.a, lib/libc++abi.a, include/c++/v1). This script
# does not resolve packages itself — canonical package builds pass their
# direct dependencies explicitly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ "$#" -ne 3 ]; then
    echo "usage: $0 <clang-dir> <libcxx-dir> <output.zip>" >&2
    exit 2
fi

CLANG_DIR="$1"
LIBCXX_DIR="$2"
OUTPUT_FILE="$3"

require_file() {
    local label="$1"
    local path="$2"
    if [ ! -f "$path" ]; then
        echo "build-kandelo-sdk-zip: required $label missing: $path" >&2
        exit 1
    fi
}

require_dir() {
    local label="$1"
    local path="$2"
    if [ ! -d "$path" ]; then
        echo "build-kandelo-sdk-zip: required $label missing: $path" >&2
        exit 1
    fi
}

require_file "clang.wasm" "$CLANG_DIR/clang.wasm"
require_file "wasm-ld.wasm" "$CLANG_DIR/wasm-ld.wasm"
require_file "llvm-ar.wasm" "$CLANG_DIR/llvm-ar.wasm"
require_file "llvm-ranlib.wasm" "$CLANG_DIR/llvm-ranlib.wasm"
require_file "llvm-nm.wasm" "$CLANG_DIR/llvm-nm.wasm"
require_file "libc++.a" "$LIBCXX_DIR/lib/libc++.a"
require_file "libc++abi.a" "$LIBCXX_DIR/lib/libc++abi.a"
require_dir "libc++ headers" "$LIBCXX_DIR/include/c++/v1"
require_file "sysroot libc.a" "$REPO_ROOT/sysroot/lib/libc.a"
require_file "wasm32posix-cc wrapper" "$REPO_ROOT/sdk/kandelo/bin/wasm32posix-cc"
require_file "config.site" "$REPO_ROOT/sdk/config.site"

if [ -n "${CLANG_RESOURCE_DIR:-}" ]; then
    HOST_CLANG_RESOURCE_DIR="$CLANG_RESOURCE_DIR"
else
    command -v clang >/dev/null || {
        echo "build-kandelo-sdk-zip: host clang not found (need it for --print-resource-dir); run via scripts/dev-shell.sh or set CLANG_RESOURCE_DIR" >&2
        exit 1
    }
    HOST_CLANG_RESOURCE_DIR="$(clang --print-resource-dir)"
fi
if [ -z "$HOST_CLANG_RESOURCE_DIR" ]; then
    echo "build-kandelo-sdk-zip: clang --print-resource-dir returned an empty path" >&2
    exit 1
fi
require_dir "Clang resource headers" "$HOST_CLANG_RESOURCE_DIR"

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/kandelo-sdk-zip.XXXXXX")"
else
    STAGING="$(mktemp -d)"
fi
# `cp -RL` below copies the host Clang resource-header tree, which may live
# in a read-only store (e.g. Nix) with non-writable directory modes. BSD cp
# (macOS) preserves those modes on `-R` even without `-p`, unlike GNU cp, so
# without restoring write permission first, cleanup on exit fails partway
# through and leaves the private staging tree behind.
trap 'chmod -R u+w "$STAGING" 2>/dev/null; rm -rf "$STAGING"' EXIT

echo "==> Staging kandelo-sdk.zip..."
echo "    clang dir:  $CLANG_DIR"
echo "    libcxx dir: $LIBCXX_DIR"
echo "    resources:  $HOST_CLANG_RESOURCE_DIR"

# --- lib/llvm/bin — the toolchain binaries, stored without .wasm ---
mkdir -p "$STAGING/lib/llvm/bin"
cp -L "$CLANG_DIR/clang.wasm" "$STAGING/lib/llvm/bin/clang"
cp -L "$CLANG_DIR/wasm-ld.wasm" "$STAGING/lib/llvm/bin/wasm-ld"
cp -L "$CLANG_DIR/llvm-ar.wasm" "$STAGING/lib/llvm/bin/llvm-ar"
cp -L "$CLANG_DIR/llvm-ranlib.wasm" "$STAGING/lib/llvm/bin/llvm-ranlib"
cp -L "$CLANG_DIR/llvm-nm.wasm" "$STAGING/lib/llvm/bin/llvm-nm"
chmod 755 \
    "$STAGING/lib/llvm/bin/clang" \
    "$STAGING/lib/llvm/bin/wasm-ld" \
    "$STAGING/lib/llvm/bin/llvm-ar" \
    "$STAGING/lib/llvm/bin/llvm-ranlib" \
    "$STAGING/lib/llvm/bin/llvm-nm"
ln -s clang "$STAGING/lib/llvm/bin/clang++"

# --- lib/llvm/lib/clang/21 — Clang resource headers ---
mkdir -p "$STAGING/lib/llvm/lib/clang/21"
cp -RL "$HOST_CLANG_RESOURCE_DIR/." "$STAGING/lib/llvm/lib/clang/21/"

# --- wasm32posix/sysroot — musl + libc++ ---
mkdir -p "$STAGING/wasm32posix/sysroot"
cp -RL "$REPO_ROOT/sysroot/." "$STAGING/wasm32posix/sysroot/"
mkdir -p "$STAGING/wasm32posix/sysroot/lib"
cp "$LIBCXX_DIR/lib/libc++.a" "$STAGING/wasm32posix/sysroot/lib/libc++.a"
cp "$LIBCXX_DIR/lib/libc++abi.a" "$STAGING/wasm32posix/sysroot/lib/libc++abi.a"
rm -rf "$STAGING/wasm32posix/sysroot/include/c++/v1"
mkdir -p "$STAGING/wasm32posix/sysroot/include/c++"
cp -RL "$LIBCXX_DIR/include/c++/v1" "$STAGING/wasm32posix/sysroot/include/c++/v1"

# --- wasm32posix/glue — the glue sources the wrapper recompiles ---
mkdir -p "$STAGING/wasm32posix/glue"
cp "$REPO_ROOT/libc/glue/"*.c "$STAGING/wasm32posix/glue/"

# --- wasm32posix/glue-objects — precompiled glue objects ---
mkdir -p "$STAGING/wasm32posix/glue-objects"
export WASM_POSIX_SYSROOT="$STAGING/wasm32posix/sysroot"
export WASM_POSIX_CLANG_RESOURCE_DIR="$HOST_CLANG_RESOURCE_DIR"
export WASM_POSIX_GLUE_DIR="$REPO_ROOT/libc/glue"
export WASM_POSIX_GLUE_OBJ_DIR="$STAGING/wasm32posix/glue-objects"
for src in channel_syscall compiler_rt cxxrt dlopen; do
    wasm32posix-cc -O2 -c "$WASM_POSIX_GLUE_DIR/${src}.c" \
        -o "$STAGING/wasm32posix/glue-objects/${src}.o"
done

# --- bin — the SDK compiler-wrapper scripts, plus short-name symlinks ---
mkdir -p "$STAGING/bin"
cp -R "$REPO_ROOT/sdk/kandelo/bin/." "$STAGING/bin/"
find "$STAGING/bin" -maxdepth 1 -type f -exec chmod 755 {} +
ln -s wasm32posix-cc "$STAGING/bin/cc"
ln -s wasm32posix-cc "$STAGING/bin/c89"
ln -s wasm32posix-cc "$STAGING/bin/c99"
ln -s wasm32posix-c++ "$STAGING/bin/c++"

# --- wasm32posix/config.site — autoconf cross-compilation cache ---
cp "$REPO_ROOT/sdk/config.site" "$STAGING/wasm32posix/config.site"

bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"

echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
