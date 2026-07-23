#!/usr/bin/env bash
set -euo pipefail

# Build Info-ZIP unzip 6.0 for wasm32-posix-kernel.
#
# Plain Makefile build with CC override.
# unzip has its own inflate (no zlib needed).
# Outputs: packages/registry/unzip/bin/{unzip,funzip}.wasm

UNZIP_VERSION="${UNZIP_VERSION:-60}"
UNZIP_SHA256="036d96991646d0449ed0aa952e4fbe21b476ce994abc276e49d30e686708bd37"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/unzip-src"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

# --- Prerequisites ---
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

# --- Download unzip source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading unzip $UNZIP_VERSION..."
    TARBALL="unzip${UNZIP_VERSION}.tar.gz"
    URL="https://downloads.sourceforge.net/infozip/${TARBALL}"
    TARBALL_PATH="$(mktemp "${TMPDIR:-/tmp}/${TARBALL}.XXXXXX")"
    trap 'rm -f "$TARBALL_PATH"' EXIT
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL -L "$URL" -o "$TARBALL_PATH"
    printf '%s  %s\n' "$UNZIP_SHA256" "$TARBALL_PATH" | sha256sum -c -
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL_PATH" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL_PATH"
    trap - EXIT
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

echo "==> Collecting binaries..."
mkdir -p "$BIN_DIR"

for program in unzip funzip; do
    if [ ! -f "$SRC_DIR/$program" ]; then
        echo "ERROR: $program binary not found after build" >&2
        exit 1
    fi
    cp "$SRC_DIR/$program" "$BIN_DIR/$program.wasm"
    echo "==> Built $program"
    ls -lh "$BIN_DIR/$program.wasm"
done

echo ""
echo "==> unzip and funzip built successfully!"
echo "Binaries: $BIN_DIR/unzip.wasm $BIN_DIR/funzip.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary unzip "$SCRIPT_DIR/bin/unzip.wasm"
install_local_binary unzip "$SCRIPT_DIR/bin/funzip.wasm"
