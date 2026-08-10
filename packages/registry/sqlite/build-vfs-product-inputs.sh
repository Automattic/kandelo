#!/usr/bin/env bash
# Transitional physical adapter for manifest-selected SQLite VFS outputs.
# Product membership and every input remain owned by the canonical VFS
# manifest; this script only turns the exact paths supplied by composition into
# package-owned bytes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"

if [ "${KANDELO_ABI_STAGING_PRODUCT:-0}" != 1 ]; then
    echo "ERROR: SQLite VFS product adapter is staging-only" >&2
    exit 2
fi
if [ "${KANDELO_VFS_PRODUCT_PACKAGE:-}" != sqlite ] || \
   [ "${WASM_POSIX_DEP_NAME:-}" != sqlite ]; then
    echo "ERROR: SQLite VFS product adapter lacks its manifest-derived package scope" >&2
    exit 2
fi

kandelo_package_prepare_build_roots "$SCRIPT_DIR/sqlite-vfs-product-work" wasm32
SQLITE_DEVELOPMENT="$({ kandelo_package_require_existing_real_dir \
    "exact SQLite development files" \
    "${KANDELO_SQLITE_DEVELOPMENT_FILES:-}"; })"
TCL_DEVELOPMENT="$({ kandelo_package_require_existing_real_dir \
    "exact Tcl development files" \
    "${KANDELO_SQLITE_TCL_DEVELOPMENT_FILES:-}"; })"
ZLIB_ROOT="$({ kandelo_package_require_existing_real_dir \
    "exact zlib package root" \
    "${KANDELO_SQLITE_ZLIB_ROOT:-}"; })"
SQLITE_FULL_SOURCE="$({ kandelo_package_require_existing_real_dir \
    "exact SQLite full source" \
    "${KANDELO_SQLITE_FULL_SOURCE:-}"; })"
SYSROOT="$({ kandelo_package_require_existing_real_dir \
    "exact SQLite sysroot" "${WASM_POSIX_SYSROOT:-}"; })"

for required_file in \
    "$SQLITE_DEVELOPMENT/sqlite3.c" \
    "$SQLITE_DEVELOPMENT/shell.c" \
    "$TCL_DEVELOPMENT/lib/libtcl8.6.a" \
    "$ZLIB_ROOT/lib/libz.a" \
    "$SYSROOT/lib/libc.a"; do
    if [ ! -s "$required_file" ] || [ -L "$required_file" ]; then
        echo "ERROR: SQLite VFS product adapter input is unavailable: $required_file" >&2
        exit 1
    fi
done
if [ ! -d "$SQLITE_FULL_SOURCE/src" ] || [ -L "$SQLITE_FULL_SOURCE/src" ]; then
    echo "ERROR: SQLite VFS product adapter full source omits src/" >&2
    exit 1
fi

# Rebuild the ordinary SQLite package from the exact selected source. The
# selector environment causes that recipe to project development-files and the
# sqlite3 program only when the product manifest asks for them.
WASM_POSIX_DEP_SOURCE_DIR="$SQLITE_DEVELOPMENT" \
WASM_POSIX_SYSROOT="$SYSROOT" \
    bash "$SCRIPT_DIR/build-sqlite.sh"

testfixture="$KANDELO_PACKAGE_WORK_DIR/testfixture.wasm"
builder="$SCRIPT_DIR/build-testfixture.sh"
if [ -n "${KANDELO_SQLITE_TESTFIXTURE_BUILDER:-}" ]; then
    if [ "${KANDELO_ABI_STAGING_TESTING:-0}" != 1 ] || \
       [ "${GITHUB_ACTIONS:-}" = true ]; then
        echo "ERROR: SQLite testfixture builder replacement is local-test-only" >&2
        exit 2
    fi
    builder="$KANDELO_SQLITE_TESTFIXTURE_BUILDER"
fi
if [ ! -f "$builder" ] || [ -L "$builder" ] || [ ! -x "$builder" ]; then
    echo "ERROR: SQLite testfixture builder is unavailable: $builder" >&2
    exit 1
fi

KANDELO_SQLITE_DEVELOPMENT_FILES="$SQLITE_DEVELOPMENT" \
KANDELO_SQLITE_TCL_DEVELOPMENT_FILES="$TCL_DEVELOPMENT" \
KANDELO_SQLITE_ZLIB_ROOT="$ZLIB_ROOT" \
KANDELO_SQLITE_FULL_SOURCE="$SQLITE_FULL_SOURCE" \
KANDELO_SQLITE_TESTFIXTURE_WORK_DIR="$KANDELO_PACKAGE_WORK_DIR/testfixture-build" \
KANDELO_SQLITE_TESTFIXTURE_OUT="$testfixture" \
WASM_POSIX_SYSROOT="$SYSROOT" \
    bash "$builder"
kandelo_package_project_requested_vfs_output testfixture "$testfixture"

echo "SQLite manifest-selected VFS outputs are ready"
