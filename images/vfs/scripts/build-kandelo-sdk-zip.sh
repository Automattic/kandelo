#!/usr/bin/env bash
#
# Build kandelo-sdk.zip for the browser shell demo.
#
# Packages the whole C/C++ toolchain — clang/wasm-ld/llvm-ar/llvm-ranlib/
# llvm-nm, the Clang resource headers, the wasm32 sysroot (libc + libc++),
# the SDK driver (wasm32posix-cc and the other SDK tools), wasm-opt and
# wasm-fork-instrument — into
# a single archive. The demo registers this as a lazy archive with mount
# prefix /usr/, so entries become /usr/lib/llvm/bin/clang,
# /usr/wasm32posix/sysroot/..., /usr/bin/cc, and so on. On first exec of cc
# (or clang), the whole archive is fetched and unpacked in one go.
#
# The SDK driver is the build machine's driver (crates/kandelo-cc) compiled
# for Kandelo, wasm-opt is the Binaryen release the build machine uses and
# wasm-fork-instrument is the build machine's instrumenter, so a program
# compiled inside Kandelo goes through the same compiler, linker, post-link
# and fork-instrumentation jobs it would on the build machine.
#
# Usage:
#   build-kandelo-sdk-zip.sh <clang-dir> <libcxx-dir> <kandelo-cc-dir> \
#       <binaryen-dir> <fork-instrument-dir> <output.zip>
#
# <clang-dir> is the resolved `clang` package output directory (the 5 wasm
# binaries: clang.wasm, wasm-ld.wasm, llvm-ar.wasm, llvm-ranlib.wasm,
# llvm-nm.wasm). <libcxx-dir> is the resolved `libcxx` package output
# directory (lib/libc++.a, lib/libc++abi.a, include/c++/v1). <kandelo-cc-dir>
# holds kandelo-cc.wasm, <binaryen-dir> wasm-opt.wasm and
# <fork-instrument-dir> wasm-fork-instrument.wasm. This script does
# not resolve packages itself — canonical package builds pass their direct
# dependencies explicitly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ "$#" -ne 6 ]; then
    echo "usage: $0 <clang-dir> <libcxx-dir> <kandelo-cc-dir> <binaryen-dir> <fork-instrument-dir> <output.zip>" >&2
    exit 2
fi

CLANG_DIR="$1"
LIBCXX_DIR="$2"
KANDELO_CC_DIR="$3"
BINARYEN_DIR="$4"
FORK_INSTRUMENT_DIR="$5"
OUTPUT_FILE="$6"

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
require_file "kandelo-cc.wasm" "$KANDELO_CC_DIR/kandelo-cc.wasm"
require_file "wasm-opt.wasm" "$BINARYEN_DIR/wasm-opt.wasm"
require_file "wasm-fork-instrument.wasm" "$FORK_INSTRUMENT_DIR/wasm-fork-instrument.wasm"
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
require_dir "Clang resource headers" "$HOST_CLANG_RESOURCE_DIR/include"
# The resource headers are part of the compiler: they must be the guest
# clang's own version, or a program could compile differently inside
# Kandelo. They come from the build machine's clang, so require the same
# release the clang package builds.
CLANG_VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$REPO_ROOT/packages/registry/clang/package.toml")"
HOST_CLANG_VERSION="$(clang --version 2>/dev/null | sed -n 's/.*clang version \([0-9.]*\).*/\1/p' | head -1)"
if [ -z "${CLANG_RESOURCE_DIR:-}" ] && [ "$HOST_CLANG_VERSION" != "$CLANG_VERSION" ]; then
    echo "build-kandelo-sdk-zip: the build machine's clang is $HOST_CLANG_VERSION, the guest clang $CLANG_VERSION; their resource headers differ" >&2
    exit 1
fi

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
# Only target-independent headers belong in the guest resource tree. Host
# compiler-rt libraries (e.g. Darwin Mach-O archives) are not guest libraries.
cp -RL "$HOST_CLANG_RESOURCE_DIR/include" "$STAGING/lib/llvm/lib/clang/21/"

# --- wasm32posix/sysroot — musl + libc++ ---
mkdir -p "$STAGING/wasm32posix/sysroot"
cp -RL "$REPO_ROOT/sysroot/." "$STAGING/wasm32posix/sysroot/"
mkdir -p "$STAGING/wasm32posix/sysroot/lib"
cp "$LIBCXX_DIR/lib/libc++.a" "$STAGING/wasm32posix/sysroot/lib/libc++.a"
cp "$LIBCXX_DIR/lib/libc++abi.a" "$STAGING/wasm32posix/sysroot/lib/libc++abi.a"
rm -rf "$STAGING/wasm32posix/sysroot/include/c++/v1"
mkdir -p "$STAGING/wasm32posix/sysroot/include/c++"
cp -RL "$LIBCXX_DIR/include/c++/v1" "$STAGING/wasm32posix/sysroot/include/c++/v1"

# --- wasm32posix/glue — the glue sources AND their headers. The SDK driver
# compiles the glue into every executable it links (the same way it does on
# the build machine), and channel_syscall.c #includes abi_constants.h (plus
# gl_abi.h / syscall_imports.h), so the headers ship alongside the .c files.
mkdir -p "$STAGING/wasm32posix/glue"
cp -RL "$REPO_ROOT/libc/glue/." "$STAGING/wasm32posix/glue/"

# --- bin — the SDK driver under every SDK tool name, wasm-opt and
# wasm-fork-instrument. One driver program; the name it runs as selects the
# tool.
mkdir -p "$STAGING/bin"
cp -L "$KANDELO_CC_DIR/kandelo-cc.wasm" "$STAGING/bin/kandelo-cc"
cp -L "$BINARYEN_DIR/wasm-opt.wasm" "$STAGING/bin/wasm-opt"
cp -L "$FORK_INSTRUMENT_DIR/wasm-fork-instrument.wasm" "$STAGING/bin/wasm-fork-instrument"
chmod 755 "$STAGING/bin/kandelo-cc" "$STAGING/bin/wasm-opt" "$STAGING/bin/wasm-fork-instrument"
for tool in cc c++ ar ranlib nm strip configure pkg-config; do
    ln -s kandelo-cc "$STAGING/bin/wasm32posix-$tool"
done
for name in cc c89 c99 c++; do
    ln -s kandelo-cc "$STAGING/bin/$name"
done

# --- wasm32posix/config.site — autoconf cross-compilation cache ---
cp "$REPO_ROOT/sdk/config.site" "$STAGING/wasm32posix/config.site"

bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"

echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
