#!/usr/bin/env bash
#
# Stage tllist (header-only) for wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). Nothing compiles: the package fetches
# the release tarball and installs the one header plus a .pc so
# fcft's and foot's dependency lookups resolve.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/tllist-src"

TLLIST_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/tllist-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified tllist $TLLIST_VERSION source..."
    kandelo_package_stage_verified_source tllist "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: tllist resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR/include" "$INSTALL_DIR/lib/pkgconfig"

cp "$SRC_DIR/tllist.h" "$INSTALL_DIR/include/tllist.h"

cat > "$INSTALL_DIR/lib/pkgconfig/tllist.pc" <<EOF
prefix=$INSTALL_DIR
includedir=\${prefix}/include

Name: tllist
Description: Typed linked list C header library
Version: $TLLIST_VERSION
Cflags: -I\${includedir}
EOF

echo "==> tllist staged!"
ls -l "$INSTALL_DIR/include/tllist.h"
