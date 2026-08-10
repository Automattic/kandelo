#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d)"
cleanup() {
    chmod -R u+w "$TMP_ROOT" 2>/dev/null || true
    rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
    echo "test-package-vfs-product-projection.sh: $*" >&2
    exit 1
}

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"

KANDELO_VFS_PRODUCT_OUTPUTS="development-files,sqlite3,testfixture"
KANDELO_VFS_PRODUCT_SOURCE_ROLES="full-source"
KANDELO_VFS_PRODUCT_PACKAGE="sqlite"
WASM_POSIX_DEP_NAME="sqlite"
export KANDELO_VFS_PRODUCT_OUTPUTS KANDELO_VFS_PRODUCT_SOURCE_ROLES
export KANDELO_VFS_PRODUCT_PACKAGE WASM_POSIX_DEP_NAME
kandelo_package_vfs_output_requested sqlite3 ||
    fail "selected product output was not requested"
if kandelo_package_vfs_output_requested icu-data; then
    fail "unselected product output was requested"
fi
kandelo_package_vfs_source_role_requested full-source ||
    fail "selected product source role was not requested"
if kandelo_package_vfs_source_role_requested test-suite; then
    fail "unselected product source role was requested"
fi
if WASM_POSIX_DEP_NAME="zlib" \
    kandelo_package_vfs_output_requested sqlite3; then
    fail "a nested dependency inherited another package's product output"
fi
if KANDELO_VFS_PRODUCT_OUTPUTS="sqlite3,,testfixture" \
    kandelo_package_vfs_output_requested sqlite3 \
    2>"$TMP_ROOT/malformed-selection.err"; then
    fail "malformed product-output selection was accepted"
fi
grep -F "is not a canonical comma-separated identifier list" \
    "$TMP_ROOT/malformed-selection.err" >/dev/null ||
    fail "malformed product-output selection rejection was not explained"
out="$TMP_ROOT/out"
mkdir -p "$out"
KANDELO_PACKAGE_OUT_DIR="$out"

program="$TMP_ROOT/program.wasm"
printf '\0asmfixture\n' >"$program"
if KANDELO_VFS_PRODUCT_OUTPUTS="sqlite3,,testfixture" \
    kandelo_package_project_requested_vfs_output malformed "$program" \
    2>"$TMP_ROOT/malformed-projection.err"; then
    fail "projection wrapper swallowed a malformed selector list"
fi
kandelo_package_project_requested_vfs_output sqlite3 "$program"
cmp -s "$program" "$out/.kandelo-vfs-product-outputs/sqlite3" ||
    fail "projected output bytes changed"
kandelo_package_project_requested_vfs_output unselected "$program"
[ ! -e "$out/.kandelo-vfs-product-outputs/unselected" ] ||
    fail "unselected output was projected"

source_role="$TMP_ROOT/source-role"
mkdir -p "$source_role/test"
printf 'fixture\n' >"$source_role/test/select.test"
kandelo_package_project_requested_vfs_source_role full-source "$source_role"
cmp -s "$source_role/test/select.test" \
    "$out/.kandelo-vfs-source-roles/full-source/test/select.test" ||
    fail "projected source-role bytes changed"

development_files="$TMP_ROOT/development-files"
mkdir -p "$development_files/lib" "$development_files/include"
printf 'library\n' >"$development_files/lib/libtcl.a"
printf 'header\n' >"$development_files/include/tcl.h"
kandelo_package_project_requested_vfs_directory_output \
    development-files "$development_files"
cmp -s "$development_files/lib/libtcl.a" \
    "$out/.kandelo-vfs-product-outputs/development-files/lib/libtcl.a" ||
    fail "projected directory output bytes changed"

linked_file="$TMP_ROOT/linked-program"
ln -s "$program" "$linked_file"
if kandelo_package_project_vfs_output linked "$linked_file" \
    2>"$TMP_ROOT/linked-file.err"; then
    fail "symlink output was accepted"
fi
grep -F "must be one regular non-symlink file" \
    "$TMP_ROOT/linked-file.err" >/dev/null ||
    fail "symlink output rejection was not explained"

linked_role="$TMP_ROOT/linked-role"
ln -s "$source_role" "$linked_role"
if kandelo_package_project_vfs_source_role linked "$linked_role" \
    2>"$TMP_ROOT/linked-role.err"; then
    fail "symlink source role was accepted"
fi
grep -F "must be a real directory" "$TMP_ROOT/linked-role.err" >/dev/null ||
    fail "symlink source-role rejection was not explained"

if kandelo_package_project_vfs_output ../escape "$program" \
    2>"$TMP_ROOT/unsafe-id.err"; then
    fail "unsafe projection identifier was accepted"
fi
grep -F "must be a stable identifier" "$TMP_ROOT/unsafe-id.err" >/dev/null ||
    fail "unsafe projection identifier rejection was not explained"
[ ! -e "$TMP_ROOT/escape" ] || fail "unsafe projection escaped output root"

if kandelo_package_project_vfs_output sqlite3 "$program" \
    2>"$TMP_ROOT/duplicate.err"; then
    fail "duplicate projection overwrote its first value"
fi
grep -F "already exists" "$TMP_ROOT/duplicate.err" >/dev/null ||
    fail "duplicate projection rejection was not explained"

echo "test-package-vfs-product-projection.sh: PASS"
