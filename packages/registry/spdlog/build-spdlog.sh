#!/usr/bin/env bash
#
# Build spdlog 1.15.3 (libspdlog.a) for wasm32-posix-kernel.
#
# Pure static C++ library via cmake, compiled against the external fmt
# package (SPDLOG_FMT_EXTERNAL) instead of the bundled copy. Same
# cross-compile shape as packages/registry/fmt/build-fmt.sh.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve spdlog`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR         # install prefix
#     WASM_POSIX_DEP_VERSION         # upstream version
#     WASM_POSIX_DEP_SOURCE_URL      # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256   # expected sha256 of the tarball
#     WASM_POSIX_DEP_FMT_DIR         # resolved fmt prefix
#     WASM_POSIX_DEP_LIBCXX_DIR      # resolved libcxx prefix

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/spdlog-src"

SPDLOG_VERSION="${WASM_POSIX_DEP_VERSION:-1.15.3}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/spdlog-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/gabime/spdlog/archive/refs/tags/v${SPDLOG_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/spdlog-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

FMT_PREFIX="${WASM_POSIX_DEP_FMT_DIR:?WASM_POSIX_DEP_FMT_DIR not set (must be invoked via cargo xtask build-deps resolve spdlog)}"
# wasm32posix-c++ resolves libc++ headers through the sysroot. Project a
# private sysroot with the resolved libcxx overlaid: the worktree SDK seed
# is an input tree for every package build and must hold no symlink
# (mariadb pattern — see scripts/package-build-roots.sh).
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT="$(
    kandelo_package_prepare_private_sysroot spdlog "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading spdlog $SPDLOG_VERSION..."
    TARBALL="/tmp/spdlog-${SPDLOG_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: spdlog resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

echo "==> Configuring spdlog for wasm32 (fmt at $FMT_PREFIX)..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_SYSTEM_NAME=Linux \
    -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER=wasm32posix-cc \
    -DCMAKE_CXX_COMPILER=wasm32posix-c++ \
    -DCMAKE_AR="$(command -v wasm32posix-ar)" \
    -DCMAKE_RANLIB="$(command -v wasm32posix-ranlib)" \
    -DCMAKE_CXX_FLAGS="-fwasm-exceptions" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_PREFIX_PATH="$FMT_PREFIX" \
    -DBUILD_SHARED_LIBS=OFF \
    -DSPDLOG_FMT_EXTERNAL=ON \
    -DSPDLOG_BUILD_EXAMPLE=OFF \
    -DSPDLOG_BUILD_TESTS=OFF

echo "==> Building spdlog..."
cmake --build "$BUILD_DIR" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo "==> Installing to $INSTALL_DIR..."
cmake --install "$BUILD_DIR"

if [ ! -f "$INSTALL_DIR/lib/libspdlog.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libspdlog.a" >&2
    exit 1
fi

echo "==> spdlog $SPDLOG_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libspdlog.a"
