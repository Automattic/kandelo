#!/usr/bin/env bash
set -euo pipefail

# Build GNU libiconv's iconv(1) program for wasm32-posix-kernel.
#
# This is the same configure/make/install path as the libiconv library
# package; the declared output here is the installed bin/iconv program,
# which upstream links against the libiconv.la it just built.
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/iconv.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/libiconv-src"
STAGE_DIR="$WORK_DIR/stage"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
LIBICONV_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBICONV_VERSION:-1.17}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftp.gnu.org/pub/gnu/libiconv/libiconv-${LIBICONV_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-8f74213b56238c85a50a5329f77e06198771e70dd9a739779f4c02f65d971313}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-libiconv-source"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

# Keep direct and resolver-driven builds pinned to this worktree's SDK.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Stage verified libiconv source ---
expected_source_marker="$(printf '%s\n%s\n%s' \
    "$LIBICONV_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR" "$STAGE_DIR" "$BIN_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified GNU libiconv $LIBICONV_VERSION source..."
    kandelo_package_stage_verified_source libiconv "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring GNU libiconv for wasm32..."
    wasm32posix-configure \
        --disable-shared \
        --enable-static \
        --disable-nls \
        --prefix=/usr \
        CFLAGS="-O2" \
        2>&1 | tail -30
fi

# --- Build and install into a DESTDIR stage ---
echo "==> Building GNU libiconv and iconv(1)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30
rm -rf "$STAGE_DIR"
make install DESTDIR="$STAGE_DIR" 2>&1 | tail -30

if [ ! -f "$STAGE_DIR/usr/bin/iconv" ]; then
    echo "ERROR: iconv program missing after install" >&2
    exit 1
fi
mkdir -p "$BIN_DIR"
cp "$STAGE_DIR/usr/bin/iconv" "$BIN_DIR/iconv.wasm"
ls -lh "$BIN_DIR/iconv.wasm"
echo "==> iconv built successfully."

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary iconv "$BIN_DIR/iconv.wasm"
