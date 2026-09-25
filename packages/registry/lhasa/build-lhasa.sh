#!/usr/bin/env bash
# Cross-compile lhasa (the `lha` tool) for Kandelo with wasm32posix-cc. Used to
# extract the LZH `lh5` `resource.1` inside id's Quake shareware archive.
#
# A direct build writes packages/registry/lhasa/bin/lha.wasm. Resolver/Formula
# builds write only below their declared work and output roots.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/lhasa-src"
OUT_BIN="$WORK_DIR/lha.wasm"
SYSROOT="$REPO_ROOT/sysroot"

LHASA_VERSION="${WASM_POSIX_DEP_VERSION:-0.4.0}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/fragglet/lhasa/releases/download/v${LHASA_VERSION}/lhasa-${LHASA_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-a7fc883c304c508562fb93fa307a4c342b0c886fcc265f28b92dc0c39220c5b3}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC/.kandelo-lhasa-source"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$SYSROOT"

expected_source_marker="$(printf '%s\n%s\n%s' \
    "$LHASA_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC" "$OUT_BIN"
fi
if [ ! -d "$SRC" ]; then
    echo "==> Staging pinned lhasa source..."
    kandelo_package_stage_verified_source lhasa "$SRC" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

cd "$SRC"

# Wasm32 type sizes so configure does not guess from a failed run.
export ac_cv_sizeof_long=4
export ac_cv_sizeof_long_long=8
export ac_cv_sizeof_int=4
export ac_cv_sizeof_size_t=4

echo "==> Configuring lhasa..."
wasm32posix-configure \
    --enable-static \
    --disable-shared \
    2>&1 | tail -20

echo "==> Building lha tool..."
# Build the library and the tool only; skip the test tree (needs a host runner).
make -C lib 2>&1 | tail -10
make -C src lha 2>&1 | tail -20

if [ ! -f "$SRC/src/lha" ]; then
    echo "ERROR: lha binary not found after build" >&2
    exit 1
fi
cp "$SRC/src/lha" "$OUT_BIN"
ls -la "$OUT_BIN"
echo "==> lha.wasm built."

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lhasa "$OUT_BIN" lha.wasm
