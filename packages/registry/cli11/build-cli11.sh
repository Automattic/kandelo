#!/usr/bin/env bash
#
# Install CLI11 2.5.0 (header-only) with its CMake config package for
# wasm32-posix-kernel.
#
# No library is compiled — the point of the cmake run is the installed
# share/cmake/CLI11 config, which Quickshell's launcher consumes through
# find_package(CLI11 CONFIG REQUIRED). The cross setup mirrors
# build-fmt.sh; CMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY keeps
# cmake's compiler probe from linking an executable.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve cli11`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR         # install prefix
#     WASM_POSIX_DEP_VERSION         # upstream version
#     WASM_POSIX_DEP_SOURCE_URL      # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256   # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/cli11-src"

CLI11_VERSION="${WASM_POSIX_DEP_VERSION:-2.5.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/cli11-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/CLIUtils/CLI11/archive/refs/tags/v${CLI11_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/cli11-build"

if ! command -v wasm32posix-c++ &>/dev/null; then
    echo "ERROR: wasm32posix-c++ not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading CLI11 $CLI11_VERSION..."
    TARBALL="/tmp/cli11-${CLI11_VERSION}.tar.gz"
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
        echo "ERROR: cli11 resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

echo "==> Configuring CLI11 for wasm32..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_SYSTEM_NAME=Linux \
    -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER=wasm32posix-cc \
    -DCMAKE_CXX_COMPILER=wasm32posix-c++ \
    -DCMAKE_CXX_FLAGS="-fwasm-exceptions" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCLI11_BUILD_TESTS=OFF \
    -DCLI11_BUILD_EXAMPLES=OFF \
    -DCLI11_BUILD_DOCS=OFF \
    -DCLI11_SINGLE_FILE=OFF

echo "==> Installing to $INSTALL_DIR..."
cmake --install "$BUILD_DIR"

for artifact in include/CLI/CLI.hpp share/cmake/CLI11/CLI11Config.cmake; do
    if [ ! -f "$INSTALL_DIR/$artifact" ]; then
        echo "ERROR: Install incomplete — missing $INSTALL_DIR/$artifact" >&2
        exit 1
    fi
done

echo "==> CLI11 $CLI11_VERSION install complete!"
