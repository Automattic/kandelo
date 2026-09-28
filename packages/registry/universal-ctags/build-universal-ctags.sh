#!/usr/bin/env bash
set -euo pipefail

# Build Universal Ctags for wasm32-posix-kernel.
#
# The optional parsers that need libxml2, libyaml, jansson, libseccomp or
# PCRE2 are disabled; the C-family parsers and POSIX-required behavior do not
# use them. --enable-tmpdir names the target's /tmp: configure otherwise
# compiles in the *build host's* $TMPDIR, and `ctags -x` then fails in
# Kandelo trying to create its sort file there.
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/ctags.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/universal-ctags-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
VERSION="${WASM_POSIX_DEP_VERSION:-6.2.1}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/universal-ctags/ctags/releases/download/v${VERSION}/universal-ctags-${VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-2c63efe9e0e083dc50e6fdd8c5414781cc8873d8c8940cf553c01870ed962f8c}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-universal-ctags-source"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

# Keep direct and resolver-driven builds pinned to this worktree's SDK.
# shellcheck source=/dev/null
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

# --- Stage verified source ---
expected_source_marker="$(printf '%s\n%s\n%s' \
    "$VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR" "$BIN_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified universal-ctags $VERSION source..."
    kandelo_package_stage_verified_source universal-ctags "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"
mkdir -p "$BIN_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring Universal Ctags for wasm32..."
    wasm32posix-configure \
        --disable-xml --disable-yaml --disable-json --disable-seccomp \
        --disable-pcre2 --disable-iconv --disable-external-sort \
        --enable-tmpdir=/tmp CFLAGS="-O2" 2>&1 | tail -30
fi

# --- Build ---
echo "==> Building ctags..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" ctags 2>&1 | tail -30
cp ctags "$BIN_DIR/ctags.wasm"
ls -lh "$BIN_DIR/ctags.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary universal-ctags "$BIN_DIR/ctags.wasm"
