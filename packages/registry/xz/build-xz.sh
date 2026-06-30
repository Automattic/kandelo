#!/usr/bin/env bash
set -euo pipefail

# Build XZ Utils for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# --disable-threads is critical (no pthreads support).
# Output: xz.wasm. Resolver/Homebrew invocations install only the declared
# program output into WASM_POSIX_DEP_OUT_DIR; direct legacy invocations still
# populate packages/registry/xz/bin and sysroot.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/sdk/activate.sh"

XZ_VERSION="${WASM_POSIX_DEP_VERSION:-${XZ_VERSION:-5.6.2}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://tukaani.org/xz/xz-${XZ_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="$WORK_DIR/xz-src"
BIN_DIR="$WORK_DIR/bin"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: xz is currently packaged for wasm32 only, got $TARGET_ARCH" >&2
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

# --- Download xz source ---
expected_marker="$(printf '%s\n%s\n%s\n' "$XZ_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
SOURCE_MARKER="$SRC_DIR/.kandelo-xz-source"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_marker" ]; then
    echo "==> Existing xz source does not match requested version/source; cleaning..."
    rm -rf "$SRC_DIR"
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading xz $XZ_VERSION..."
    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-xz-src.XXXXXX")"
    trap 'rm -rf "$tmpdir"' EXIT
    case "$SOURCE_URL" in
        *.tar.gz|*.tgz) TARBALL="$tmpdir/xz-${XZ_VERSION}.tar.gz" ;;
        *.tar.xz|*.txz) TARBALL="$tmpdir/xz-${XZ_VERSION}.tar.xz" ;;
        *) TARBALL="$tmpdir/xz-${XZ_VERSION}.tar" ;;
    esac
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    printf '%s\n' "$expected_marker" > "$SOURCE_MARKER"
    trap - EXIT
    rm -rf "$tmpdir"
    echo "==> Source extracted to $SRC_DIR"

    # Patch: xz excludes __wasm__ from sigprocmask path, but our sysroot has it
    sed -i.bak 's/!defined(__wasm__)/!defined(__wasm_no_signal__)/' "$SRC_DIR/src/common/mythread.h"
    echo "==> Patched mythread.h for wasm signal support"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring xz for wasm32..."

    # Cross-compilation values
    export ac_cv_func_closedir_void=no
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes

    # No Capsicum (FreeBSD sandbox) or pledge (OpenBSD)
    export ac_cv_header_sys_capsicum_h=no
    export ac_cv_func_cap_rights_limit=no

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4

    wasm32posix-configure \
        --disable-nls \
        --disable-threads \
        --disable-shared \
        --enable-static \
        --disable-doc \
        --disable-scripts \
        --disable-lzmadec \
        --disable-lzmainfo \
        --enable-sandbox=no \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building xz..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/src/xz/xz" ]; then
    cp "$SRC_DIR/src/xz/xz" "$BIN_DIR/xz.wasm"
    echo "==> Built xz"
    ls -lh "$BIN_DIR/xz.wasm"
else
    echo "ERROR: xz binary not found after build" >&2
    exit 1
fi

if [ -n "$INSTALL_DIR" ]; then
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    wasm_require_no_legacy_asyncify "$BIN_DIR/xz.wasm"
    wasm_require_no_fork_instrumentation "$BIN_DIR/xz.wasm"
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cp "$BIN_DIR/xz.wasm" "$INSTALL_DIR/xz.wasm"
    echo "==> Installed xz.wasm to $INSTALL_DIR"
else
    # --- Install library to sysroot (legacy direct invocation only) ---
    echo "==> Installing liblzma.a and headers to sysroot..."
    if [ -f "$SRC_DIR/src/liblzma/.libs/liblzma.a" ]; then
        cp "$SRC_DIR/src/liblzma/.libs/liblzma.a" "$SYSROOT/lib/"
        mkdir -p "$SYSROOT/include/lzma"
        cp "$SRC_DIR/src/liblzma/api/lzma.h" "$SYSROOT/include/"
        cp "$SRC_DIR/src/liblzma/api/lzma/"*.h "$SYSROOT/include/lzma/"
        echo "==> Installed liblzma.a and headers"
    fi

    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary xz "$SCRIPT_DIR/bin/xz.wasm"
fi

echo ""
echo "==> xz built successfully!"
echo "Binary: $BIN_DIR/xz.wasm"
