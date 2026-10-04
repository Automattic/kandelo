#!/usr/bin/env bash
set -euo pipefail

# Build Info-ZIP unzip 6.0 for wasm32-posix-kernel.
#
# Plain Makefile build with CC override.
# unzip has its own inflate (no zlib needed).
# Output: bin/unzip.wasm under the resolver work root (beside this
# script when run standalone).

UNZIP_VERSION="${UNZIP_VERSION:-60}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/unzip-src"
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

# --- Download unzip source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading unzip $UNZIP_VERSION..."
    URL="https://downloads.sourceforge.net/infozip/unzip${UNZIP_VERSION}.tar.gz"
    # WHY: a unique archive under the work root; a fixed /tmp name let two
    # concurrent builds overwrite or delete each other's download.
    TARBALL="$(mktemp "$KANDELO_PACKAGE_WORK_DIR/unzip-source.XXXXXX")"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL -L "$URL" -o "$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm -f "$TARBALL"
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
install_local_binary unzip "$BIN_DIR/unzip.wasm"
