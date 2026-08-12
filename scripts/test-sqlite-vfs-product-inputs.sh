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
    echo "test-sqlite-vfs-product-inputs.sh: $*" >&2
    exit 1
}

source_root="$TMP_ROOT/source"
work_root="$TMP_ROOT/work"
out_root="$TMP_ROOT/out"
sysroot="$TMP_ROOT/sysroot"
tools="$TMP_ROOT/tools"
mkdir -p "$source_root" "$work_root" "$out_root" "$sysroot/lib" "$tools"
printf 'int sqlite3_fixture;\n' >"$source_root/sqlite3.c"
printf 'int shell_fixture;\n' >"$source_root/shell.c"
printf '/* sqlite3 */\n' >"$source_root/sqlite3.h"
printf '/* sqlite3ext */\n' >"$source_root/sqlite3ext.h"
printf 'libc\n' >"$sysroot/lib/libc.a"

cat >"$tools/wasm32posix-cc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
output=""
while (($#)); do
    if [ "$1" = -o ]; then
        shift
        output="${1:-}"
    fi
    shift || true
done
[ -n "$output" ]
mkdir -p "$(dirname "$output")"
printf '\0asmfixture\n' >"$output"
EOF
cat >"$tools/wasm32posix-ar" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" -ge 2 ]
output="$2"
mkdir -p "$(dirname "$output")"
printf 'archive fixture\n' >"$output"
EOF
chmod 0755 "$tools/wasm32posix-cc" "$tools/wasm32posix-ar"

before="$(find "$source_root" -type f -print0 | sort -z | xargs -0 shasum -a 256)"
env \
    PATH="$tools:$PATH" \
    WASM_POSIX_DEP_NAME=sqlite \
    WASM_POSIX_DEP_VERSION=3.49.1 \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_DEP_SOURCE_DIR="$source_root" \
    WASM_POSIX_DEP_WORK_DIR="$work_root" \
    WASM_POSIX_DEP_OUT_DIR="$out_root" \
    WASM_POSIX_SYSROOT="$sysroot" \
    KANDELO_VFS_PRODUCT_PACKAGE=sqlite \
    KANDELO_VFS_PRODUCT_OUTPUTS=development-files \
    KANDELO_VFS_PRODUCT_SOURCE_ROLES= \
    bash "$REPO_ROOT/packages/registry/sqlite/build-sqlite.sh"

[ -s "$out_root/lib/libsqlite3.a" ] || fail "SQLite library was not installed"
[ -s "$out_root/include/sqlite3.h" ] || fail "SQLite header was not installed"
development="$out_root/.kandelo-vfs-product-outputs/development-files"
[ -s "$development/sqlite3.c" ] || fail "amalgamation source was not projected"
[ -s "$development/shell.c" ] || fail "shell source was not projected"
[ ! -e "$development/sqlite3.o" ] || fail "generated object contaminated source projection"
[ ! -e "$development/libsqlite3.a" ] || fail "generated library contaminated source projection"
after="$(find "$source_root" -type f -print0 | sort -z | xargs -0 shasum -a 256)"
[ "$before" = "$after" ] || fail "verified SQLite source was mutated"

# Staging must never let the legacy helper choose or download the full source.
tcl_root="$TMP_ROOT/tcl-development"
zlib_root="$TMP_ROOT/zlib"
mkdir -p "$tcl_root/lib" "$zlib_root/lib"
printf 'tcl\n' >"$tcl_root/lib/libtcl8.6.a"
printf 'zlib\n' >"$zlib_root/lib/libz.a"
cat >"$tools/curl" <<EOF
#!/usr/bin/env bash
printf 'called\n' >"$TMP_ROOT/curl-called"
exit 92
EOF
chmod 0755 "$tools/curl"
if env \
    PATH="$tools:$PATH" \
    KANDELO_ABI_STAGING_PRODUCT=1 \
    KANDELO_SQLITE_DEVELOPMENT_FILES="$source_root" \
    KANDELO_SQLITE_TCL_DEVELOPMENT_FILES="$tcl_root" \
    KANDELO_SQLITE_ZLIB_ROOT="$zlib_root" \
    KANDELO_SQLITE_FULL_SOURCE="$TMP_ROOT/missing-full-source" \
    KANDELO_SQLITE_TESTFIXTURE_WORK_DIR="$TMP_ROOT/testfixture-work" \
    KANDELO_SQLITE_TESTFIXTURE_OUT="$TMP_ROOT/testfixture.wasm" \
    WASM_POSIX_SYSROOT="$sysroot" \
    bash "$REPO_ROOT/packages/registry/sqlite/build-testfixture.sh" \
    >"$TMP_ROOT/missing-source.out" 2>&1; then
    fail "staging testfixture accepted a missing exact full source"
fi
grep -F "exact full source" "$TMP_ROOT/missing-source.out" >/dev/null ||
    fail "missing exact full-source rejection was not explicit"
[ ! -e "$TMP_ROOT/curl-called" ] ||
    fail "staging testfixture attempted an undeclared download"

full_source="$TMP_ROOT/full-source"
adapter_out="$TMP_ROOT/adapter-out"
adapter_work="$TMP_ROOT/adapter-work"
mkdir -p "$full_source/src" "$adapter_out" "$adapter_work"
printf 'fixture\n' >"$full_source/src/sqliteInt.h"
fake_testfixture="$TMP_ROOT/fake-testfixture-builder"
cat >"$fake_testfixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${KANDELO_SQLITE_TESTFIXTURE_OUT:?}"
printf '\0asmtestfixture\n' >"$KANDELO_SQLITE_TESTFIXTURE_OUT"
EOF
chmod 0755 "$fake_testfixture"
env \
    PATH="$tools:$PATH" \
    KANDELO_ABI_STAGING_PRODUCT=1 \
    KANDELO_ABI_STAGING_TESTING=1 \
    KANDELO_SQLITE_TESTFIXTURE_BUILDER="$fake_testfixture" \
    KANDELO_SQLITE_DEVELOPMENT_FILES="$source_root" \
    KANDELO_SQLITE_TCL_DEVELOPMENT_FILES="$tcl_root" \
    KANDELO_SQLITE_ZLIB_ROOT="$zlib_root" \
    KANDELO_SQLITE_FULL_SOURCE="$full_source" \
    KANDELO_VFS_PRODUCT_PACKAGE=sqlite \
    KANDELO_VFS_PRODUCT_OUTPUTS=development-files,sqlite3,testfixture \
    KANDELO_VFS_PRODUCT_SOURCE_ROLES= \
    WASM_POSIX_DEP_NAME=sqlite \
    WASM_POSIX_DEP_OUT_DIR="$adapter_out" \
    WASM_POSIX_DEP_WORK_DIR="$adapter_work" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_SYSROOT="$sysroot" \
    bash "$REPO_ROOT/packages/registry/sqlite/build-vfs-product-inputs.sh"

[ -s "$adapter_out/.kandelo-vfs-product-outputs/sqlite3" ] ||
    fail "SQLite VFS adapter omitted sqlite3"
[ -s "$adapter_out/.kandelo-vfs-product-outputs/testfixture" ] ||
    fail "SQLite VFS adapter omitted testfixture"
[ -s "$adapter_out/.kandelo-vfs-product-outputs/development-files/sqlite3.c" ] ||
    fail "SQLite VFS adapter omitted its selected development files"

echo "test-sqlite-vfs-product-inputs.sh: PASS"
