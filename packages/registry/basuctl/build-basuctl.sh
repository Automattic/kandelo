#!/usr/bin/env bash
#
# Build basuctl for Kandelo by linking upstream's busctl.c against the basu
# library package's libbasu.a. busctl.c includes basu's private headers, so
# it compiles against the staged source tree with basu's hand-curated
# config.h, the same one libbasu.a was built with.
#
# A direct build writes the work directory below packages/registry/basuctl.
# Resolver builds write only below their declared work and output roots.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/basu-src"
OUT_BIN="$WORK_DIR/basuctl.wasm"
BASU_DIR="${WASM_POSIX_DEP_BASU_DIR:?resolver did not provide the basu dependency}"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

source "$REPO_ROOT/sdk/activate.sh"

echo "==> Staging pinned basu source for busctl.c..."
kandelo_package_stage_primary_source basuctl "$SRC" "$WORK_DIR"

echo "==> Linking basuctl against libbasu.a..."
wasm32posix-cc -O2 -std=gnu99 \
    -include "$REPO_ROOT/packages/registry/basu/src/config.h" \
    -I"$SRC/src/basic" \
    -I"$SRC/src/systemd" \
    -I"$SRC/src/libsystemd/sd-bus" \
    -Wno-typedef-redefinition -Wno-gnu-variable-sized-type-not-at-end \
    "$SRC/src/busctl/busctl.c" "$SRC/src/busctl/busctl-introspect.c" \
    -L"$BASU_DIR/lib" -lbasu \
    -o "$OUT_BIN"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary basuctl "$OUT_BIN" basuctl.wasm
