#!/usr/bin/env bash
# Build msmtpd, the minimal SMTP server shipped with msmtp, for wasm32-posix.
# The WordPress demo runs it as a local SMTP capture service and supplies a
# shell delivery command that writes each accepted message into the VFS.
set -euo pipefail

VERSION="1.8.32"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://snapshot.debian.org/archive/debian/20251129T142942Z/pool/main/m/msmtp/msmtp_1.8.32.orig.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-20cd58b58dd007acf7b937fa1a1e21f3afb3e9ef5bbcfb8b4f5650deadc64db4}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/msmtp-src"
BIN_DIR="$KANDELO_PACKAGE_WORK_DIR/bin"
OUT="$BIN_DIR/msmtpd.wasm"

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# Standalone-only shortcut: a resolver build always compiles from its
# verified source rather than republishing an earlier artifact.
if [ -z "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -f "$OUT" ]; then
    echo "==> Reusing existing msmtpd artifact in $BIN_DIR (skip rebuild)."
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary msmtpd "$OUT"
    exit 0
fi

if ! command -v wasm32posix-cc >/dev/null 2>&1; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR/src" ]; then
    rm -rf "$SRC_DIR"
    echo "==> Downloading msmtp $VERSION..."
    # WHY: a unique archive under the work root; the old fixed archive and
    # extraction names beside this script were shared by concurrent builds.
    TARBALL="$(mktemp "$KANDELO_PACKAGE_WORK_DIR/msmtp-source.XXXXXX")"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL \
        -o "$TARBALL" \
        "$SOURCE_URL"

    actual_sha="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
    if [ "$actual_sha" != "$SOURCE_SHA256" ]; then
        rm -f "$TARBALL"
        echo "ERROR: checksum mismatch for msmtp $VERSION source" >&2
        echo "  expected: $SOURCE_SHA256" >&2
        echo "  actual:   $actual_sha" >&2
        exit 1
    fi

    echo "==> Extracting msmtp $VERSION..."
    mkdir -p "$SRC_DIR"
    tar xf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm -f "$TARBALL"
fi

cd "$SRC_DIR/src"

# The release tarball's configure script builds both the client and server.
# msmtpd itself is self-contained enough to compile directly with a tiny
# config.h, avoiding optional TLS, gettext, libsecret, and client-only deps.
cat > config.h <<EOF
#define HAVE_CONFIG_H 1
#define VERSION "$VERSION"
#define PACKAGE_NAME "msmtp"
#define PACKAGE_VERSION "$VERSION"
#define PACKAGE_STRING "msmtp $VERSION"
#define BINDIR "/usr/bin"
#define LOCALEDIR "/usr/share/locale"
#define SYSCONFDIR "/etc"
#define HAVE_GETPASS 1
#define HAVE_LANGINFO_H 1
#define HAVE_LINK 1
#define HAVE_STRNDUP 1
#define HAVE_VASPRINTF 1
EOF

echo "==> Building msmtpd..."
mkdir -p "$BIN_DIR"
wasm32posix-cc \
    -O2 \
    -DHAVE_CONFIG_H \
    -I. \
    msmtpd.c \
    base64.c \
    eval.c \
    password.c \
    stream.c \
    tools.c \
    xalloc.c \
    netrc.c \
    -o "$OUT"

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

echo "==> Applying wasm-fork-instrument to msmtpd.wasm..."
"$FORK_INSTRUMENT" "$OUT" -o "$OUT.instr"
mv "$OUT.instr" "$OUT"
ls -lh "$OUT"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary msmtpd "$OUT"

echo "==> msmtpd build complete"
