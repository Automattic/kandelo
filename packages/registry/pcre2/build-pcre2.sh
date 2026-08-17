#!/usr/bin/env bash
#
# Build PCRE2 10.44 (libpcre2-8.a) for wasm32-posix-kernel.
#
# 8-bit code unit width only, static, no JIT (wasm has no runtime code
# generation) and no pcre2grep/pcre2test. Cross-compiled through cmake
# with the wasm32posix-* toolchain drivers, the same shape as
# packages/registry/jsoncpp/build-jsoncpp.sh; PCRE2 ships prebuilt
# character tables, so no host executable runs during the build.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve pcre2`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR         # install prefix
#     WASM_POSIX_DEP_VERSION         # upstream version
#     WASM_POSIX_DEP_SOURCE_URL      # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256   # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/pcre2-src"

PCRE2_VERSION="${WASM_POSIX_DEP_VERSION:-10.44}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/pcre2-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/PCRE2Project/pcre2/releases/download/pcre2-${PCRE2_VERSION}/pcre2-${PCRE2_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

BUILD_DIR="$SCRIPT_DIR/pcre2-build"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading pcre2 $PCRE2_VERSION..."
    TARBALL="/tmp/pcre2-${PCRE2_VERSION}.tar.gz"
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

rm -rf "$BUILD_DIR" "$INSTALL_DIR"

echo "==> Configuring pcre2 for wasm32..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_SYSTEM_NAME=Linux \
    -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
    -DCMAKE_C_COMPILER=wasm32posix-cc \
    -DCMAKE_AR="$(command -v wasm32posix-ar)" \
    -DCMAKE_RANLIB="$(command -v wasm32posix-ranlib)" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_STATIC_LIBS=ON \
    -DPCRE2_BUILD_PCRE2_8=ON \
    -DPCRE2_BUILD_PCRE2_16=OFF \
    -DPCRE2_BUILD_PCRE2_32=OFF \
    -DPCRE2_STATIC_PIC=ON \
    -DPCRE2_SUPPORT_JIT=OFF \
    -DPCRE2_SUPPORT_UNICODE=ON \
    -DPCRE2_BUILD_PCRE2GREP=OFF \
    -DPCRE2_BUILD_TESTS=OFF

echo "==> Building pcre2..."
cmake --build "$BUILD_DIR" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo "==> Installing to $INSTALL_DIR..."
cmake --install "$BUILD_DIR"

# Upstream installs 2 MB of man pages + HTML docs unconditionally.
# Nothing consumes them; they would dominate the published archive.
rm -rf "$INSTALL_DIR/share"

if [ ! -f "$INSTALL_DIR/lib/libpcre2-8.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libpcre2-8.a" >&2
    exit 1
fi

echo "==> pcre2 $PCRE2_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libpcre2-8.a"
