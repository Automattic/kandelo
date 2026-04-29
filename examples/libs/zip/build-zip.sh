#!/usr/bin/env bash
set -euo pipefail

# Build Info-ZIP zip 3.0 for wasm32-posix-kernel.
#
# Plain Makefile build with CC override.
# zip has its own deflate (no zlib needed).
# Output: examples/libs/zip/bin/zip.wasm

ZIP_VERSION="${ZIP_VERSION:-30}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/zip-src"
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

# --- Download zip source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading zip $ZIP_VERSION..."
    TARBALL="zip${ZIP_VERSION}.tar.gz"
    URL="https://downloads.sourceforge.net/infozip/${TARBALL}"
    curl -fsSL -L "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Build ---
# Skip unix/configure (broken for cross-compilation) and set flags directly.
# Our sysroot has standard C library functions (memset, strchr, mktime, etc).
echo "==> Building zip..."
cat > flags <<'FLAGSEOF'
CC="wasm32posix-cc" CFLAGS="-I. -DUNIX -O2 -DUIDGID_NOT_16BIT -DHAVE_DIRENT_H -DHAVE_TERMIOS_H -DLARGE_FILE_SUPPORT" CPP="wasm32posix-cc -E" OBJA="" OCRCU8="crc32_.o " OCRCTB="" BINDIR=/usr/local/bin MANDIR=manl LFLAGS1="" LFLAGS2="" LN="ln -s" IZ_BZIP2="" LIB_BZ=""
FLAGSEOF

eval make -f unix/Makefile zips $(cat flags) 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/zip" ]; then
    cp "$SRC_DIR/zip" "$BIN_DIR/zip.wasm"
    echo "==> Built zip"
    ls -lh "$BIN_DIR/zip.wasm"
else
    echo "ERROR: zip binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> zip built successfully!"
echo "Binary: $BIN_DIR/zip.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary zip "$SCRIPT_DIR/bin/zip.wasm"
