#!/usr/bin/env bash
set -euo pipefail

# Build Info-ZIP unzip 6.0 for wasm32-posix-kernel.
#
# Plain Makefile build with CC override.
# unzip has its own inflate (no zlib needed).
# Output: bin/unzip.wasm under the declared resolver work root.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
source "$REPO_ROOT/sdk/activate.sh"
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/unzip-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
SYSROOT="$REPO_ROOT/sysroot"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# Recreate only this recipe's writable source copy so old objects cannot
# carry a stale ABI into a new build. The resolver's verified input is immutable.
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-http://downloads.sourceforge.net/infozip/unzip60.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-036d96991646d0449ed0aa952e4fbe21b476ce994abc276e49d30e686708bd37}"
rm -rf "$SRC_DIR"
kandelo_package_stage_verified_source unzip "$SRC_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
    "$KANDELO_PACKAGE_WORK_DIR"

cd "$SRC_DIR"

# --- Build ---
# Use linux_noasm target flags adapted for wasm cross-compilation.
# SYSV + MODERN enables <unistd.h> and <utime.h> includes needed for isatty, etc.
echo "==> Building unzip..."
make -f unix/Makefile unzips \
    CC=wasm32posix-cc \
    CF="-O2 -Wall -I. -DUNIX -DSYSV -DMODERN -Dlinux -DHAVE_UNISTD_H -DHAVE_DIRENT_H -DHAVE_TERMIOS_H -DACORN_FTYPE_NFS -DWILD_STOP_AT_DIR -DLARGE_FILE_SUPPORT -DUNICODE_SUPPORT -DUNICODE_WCHAR -DUTF8_MAYBE_NATIVE -DNO_LCHMOD -DDATE_FORMAT=DF_YMD -DIZ_HAVE_STRDUP -DIZ_HAVE_STRCASECMP" \
    LF2="" \
    2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/unzip" ]; then
    cp "$SRC_DIR/unzip" "$BIN_DIR/unzip.wasm"
    echo "==> Built unzip"
    ls -lh "$BIN_DIR/unzip.wasm"
else
    echo "ERROR: unzip binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> unzip built successfully!"
echo "Binary: $BIN_DIR/unzip.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary unzip "$BIN_DIR/unzip.wasm"
