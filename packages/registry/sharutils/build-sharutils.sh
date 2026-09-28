#!/usr/bin/env bash
set -euo pipefail

# Build uuencode(1) and uudecode(1) from GNU sharutils for wasm32-posix-kernel.
#
# The option parsers (src/uu*-opts.c) are pre-generated in the release
# tarball, so AutoGen is not needed. shar and unshar are built by the same
# make but are not declared outputs.
#
# patches/0001 is Debian's fix-ftbfs-with-gcc-10.patch, unmodified. The
# release's generated *-opts.h headers define `program_name` instead of
# declaring it `extern`, which links only under the old -fcommon default.
# Wasm objects have no common symbols (clang cannot emit them), so the
# headers must declare it, as Debian's patch does. This is an upstream
# portability bug, not a Kandelo gap.
#
# NLS stays enabled: sharutils calls bindtextdomain()/textdomain()
# unconditionally, and musl provides the gettext family natively.
#
# Output: $KANDELO_PACKAGE_WORK_DIR/bin/{uuencode,uudecode}.wasm

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/sharutils-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
VERSION="${WASM_POSIX_DEP_VERSION:-4.15.2}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftpmirror.gnu.org/sharutils/sharutils-${VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-2b05cff7de5d7b646dc1669bc36c35fdac02ac6ae4b6c19cb3340d87ec553a9a}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC_DIR/.kandelo-sharutils-source"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
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
    echo "==> Staging verified sharutils $VERSION source..."
    kandelo_package_stage_verified_source sharutils "$SRC_DIR" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC_DIR"
mkdir -p "$BIN_DIR"

# --- Patch ---
PATCH_MARKER="$SRC_DIR/.kandelo-patches-applied"
if [ ! -f "$PATCH_MARKER" ]; then
    for patch_file in "$SCRIPT_DIR/patches/"*.patch; do
        echo "==> Applying $(basename "$patch_file")..."
        kandelo_package_git_apply_patch "$SRC_DIR" "$patch_file"
    done
    : >"$PATCH_MARKER"
fi

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring sharutils for wasm32..."
    wasm32posix-configure CFLAGS="-O2" 2>&1 | tail -30
fi

# --- Build ---
echo "==> Building sharutils..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30
for program in uuencode uudecode; do
    cp "src/$program" "$BIN_DIR/$program.wasm"
    ls -lh "$BIN_DIR/$program.wasm"
done

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary sharutils "$BIN_DIR/uuencode.wasm"
install_local_binary sharutils "$BIN_DIR/uudecode.wasm"
