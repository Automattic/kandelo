#!/usr/bin/env bash
set -euo pipefail

# Build Info-ZIP unzip 6.0 for wasm32-posix-kernel.
#
# Plain Makefile build with CC override.
# unzip has its own inflate (no zlib needed).
# Output: examples/libs/unzip/bin/unzip.wasm

UNZIP_VERSION="${UNZIP_VERSION:-60}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/unzip-src"
BIN_DIR="$SCRIPT_DIR/bin"
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

# --- Download unzip source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading unzip $UNZIP_VERSION..."
    TARBALL="unzip${UNZIP_VERSION}.tar.gz"
    URL="https://downloads.sourceforge.net/infozip/${TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL -L "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

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
install_local_binary unzip "$SCRIPT_DIR/bin/unzip.wasm"
