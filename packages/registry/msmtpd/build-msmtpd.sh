#!/usr/bin/env bash
# Build msmtpd, the minimal SMTP server shipped with msmtp, for wasm32-posix.
# The WordPress demo runs it as a local SMTP capture service and supplies a
# shell delivery command that writes each accepted message into the VFS.
set -euo pipefail

VERSION="1.8.32"
TARBALL="msmtp-${VERSION}.tar.xz"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://snapshot.debian.org/archive/debian/20251129T142942Z/pool/main/m/msmtp/msmtp_1.8.32.orig.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-20cd58b58dd007acf7b937fa1a1e21f3afb3e9ef5bbcfb8b4f5650deadc64db4}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/msmtp-src"
BIN_DIR="$SCRIPT_DIR/bin"
OUT="$BIN_DIR/msmtpd.wasm"

# There used to be a reuse guard here: `if [ -f "$OUT" ]` then install the
# existing artifact and `exit 0`. It was the only one of its kind in the
# registry, it carried no stated reason, and it shipped a broken msmtpd.
#
# What it actually did was skip the compile AND the fork instrumentation. So
# when the fork instrumenter gained `__wpk_fork_place_resume_thunks` and the
# host began requiring it at process start, a full `./run.sh local-build`
# rebuilt msmtpd as a graph node, reported success, and published a September
# artifact byte-for-byte unchanged. The resulting binary died before `_start`
# with "activation 0 exports no __wpk_fork_place_resume_thunks", and the build
# that produced it was green.
#
# `packages/registry/*/bin/` is gitignored, so a fresh clone never had the
# stale input and instrumented normally. That is what made this invisible: it
# only reproduced in a worktree that had built msmtpd before, which is every
# long-lived development checkout and no CI job.
#
# Caching belongs to the resolver and the source-only cache, which key on the
# build closure. A package script deciding for itself that its own output is
# still good cannot see that a tool upstream of it changed.

if ! command -v wasm32posix-cc >/dev/null 2>&1; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/$TARBALL" ]; then
    echo "==> Downloading msmtp $VERSION..."
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL \
        -o "$SCRIPT_DIR/$TARBALL" \
        "$SOURCE_URL"
fi

actual_sha="$(shasum -a 256 "$SCRIPT_DIR/$TARBALL" | awk '{print $1}')"
if [ "$actual_sha" != "$SOURCE_SHA256" ]; then
    echo "ERROR: checksum mismatch for $TARBALL" >&2
    echo "  expected: $SOURCE_SHA256" >&2
    echo "  actual:   $actual_sha" >&2
    exit 1
fi

if [ ! -d "$SRC_DIR/src" ]; then
    echo "==> Extracting msmtp $VERSION..."
    rm -rf "$SRC_DIR"
    tar xf "$SCRIPT_DIR/$TARBALL" -C "$SCRIPT_DIR"
    mv "$SCRIPT_DIR/msmtp-$VERSION" "$SRC_DIR"
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
