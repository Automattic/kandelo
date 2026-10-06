#!/usr/bin/env bash
# Build msmtpd, the minimal SMTP server shipped with msmtp, for wasm32-posix.
# The WordPress demo runs it as a local SMTP capture service and supplies a
# shell delivery command that writes each accepted message into the VFS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
# shellcheck source=/dev/null
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

# There used to be a standalone-only reuse guard here: if "$OUT" existed,
# install it and `exit 0`. It was the only one of its kind in the registry,
# and it skipped the compile AND the fork instrumentation. After the fork
# instrumenter changed, a standalone run therefore reinstalled the previous
# artifact byte-for-byte while reporting success; on the branch where this
# was found, the stale binary died before `_start` because the instrumenter
# had gained an export the host requires at process start.
#
# `bin/` is gitignored, so a fresh clone never had the stale input. That is
# what made this invisible: it only reproduced in a long-lived checkout that
# had built msmtpd before.
#
# Caching belongs to the resolver and the source-only cache, which key on the
# build closure. A package script deciding for itself that its own output is
# still good cannot see that a tool upstream of it changed.

if ! command -v wasm32posix-cc >/dev/null 2>&1; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

kandelo_package_stage_primary_source msmtpd "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"

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
