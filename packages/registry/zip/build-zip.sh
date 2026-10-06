#!/usr/bin/env bash
set -euo pipefail

# Build Info-ZIP zip 3.0 for wasm32-posix-kernel.
#
# Plain Makefile build with CC override.
# zip has its own deflate (no zlib needed).
# Output: bin/zip.wasm under the resolver work root (beside this
# script when run standalone).

ZIP_VERSION="${ZIP_VERSION:-30}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/zip-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

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

# --- Stage the pinned zip source ---
# Under the resolver the verified, unpacked source arrives in
# WASM_POSIX_DEP_SOURCE_DIR (from the resolver's source-archive cache, so a
# rebuild does not depend on the upstream mirror being up); a direct run
# downloads the archive and checks its sha256.
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-http://downloads.sourceforge.net/infozip/zip${ZIP_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-f0e8bb1f9b7eb0b01285495a2699df3a4b766784c1765a8f1aeedf63c0806369}"
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging pinned zip $ZIP_VERSION source..."
    kandelo_package_stage_verified_source zip "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
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
install_local_binary zip "$BIN_DIR/zip.wasm"
