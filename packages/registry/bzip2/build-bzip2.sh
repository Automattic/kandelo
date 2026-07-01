#!/usr/bin/env bash
set -euo pipefail

# Build bzip2 1.0.8 for wasm32-posix-kernel.
#
# Plain Makefile build with CC/AR/RANLIB overrides.
# Output: bzip2.wasm. Resolver/Homebrew invocations install only the
# declared program output into WASM_POSIX_DEP_OUT_DIR; direct legacy
# invocations still populate packages/registry/bzip2/bin and sysroot.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/sdk/activate.sh"

BZIP2_VERSION="${WASM_POSIX_DEP_VERSION:-${BZIP2_VERSION:-1.0.8}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://sourceware.org/pub/bzip2/bzip2-${BZIP2_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="$WORK_DIR/bzip2-src"
BIN_DIR="$WORK_DIR/bin"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: bzip2 is currently packaged for wasm32 only, got $TARGET_ARCH" >&2
    exit 2
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run scripts/build-musl.sh first." >&2
    exit 1
fi

# --- Download bzip2 source ---
expected_marker="$(printf '%s\n%s\n%s\n' "$BZIP2_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
SOURCE_MARKER="$SRC_DIR/.kandelo-bzip2-source"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_marker" ]; then
    echo "==> Existing bzip2 source does not match requested version/source; cleaning..."
    rm -rf "$SRC_DIR"
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading bzip2 $BZIP2_VERSION..."
    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-bzip2-src.XXXXXX")"
    trap 'rm -rf "$tmpdir"' EXIT
    TARBALL="$tmpdir/bzip2-${BZIP2_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    printf '%s\n' "$expected_marker" > "$SOURCE_MARKER"
    trap - EXIT
    rm -rf "$tmpdir"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"
make clean >/dev/null 2>&1 || true

# --- Build ---
echo "==> Building bzip2..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    CC=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    CFLAGS="-Wall -Winline -O2 -D_FILE_OFFSET_BITS=64" \
    LDFLAGS="" \
    bzip2 bzip2recover libbz2.a \
    2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/bzip2" ]; then
    cp "$SRC_DIR/bzip2" "$BIN_DIR/bzip2.wasm"
    echo "==> Built bzip2"
    ls -lh "$BIN_DIR/bzip2.wasm"
else
    echo "ERROR: bzip2 binary not found after build" >&2
    exit 1
fi

if [ -n "$INSTALL_DIR" ]; then
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    wasm_require_no_legacy_asyncify "$BIN_DIR/bzip2.wasm"
    wasm_require_no_fork_instrumentation "$BIN_DIR/bzip2.wasm"
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cp "$BIN_DIR/bzip2.wasm" "$INSTALL_DIR/bzip2.wasm"
    echo "==> Installed bzip2.wasm to $INSTALL_DIR"
else
    # --- Install library to sysroot (legacy direct invocation only) ---
    echo "==> Installing libbz2.a and bzlib.h to sysroot..."
    cp "$SRC_DIR/libbz2.a" "$SYSROOT/lib/"
    cp "$SRC_DIR/bzlib.h" "$SYSROOT/include/"
    echo "==> Installed libbz2.a and bzlib.h"

    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary bzip2 "$SCRIPT_DIR/bin/bzip2.wasm"
fi

echo ""
echo "==> bzip2 built successfully!"
echo "Binary: $BIN_DIR/bzip2.wasm"
