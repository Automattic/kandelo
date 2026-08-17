#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
    echo "test-package-isolated-output-contracts: $*" >&2
    exit 1
}

tcl="$REPO_ROOT/packages/registry/tcl/build-tcl.sh"
grep -F 'ls -lh "$TCLSH"' "$tcl" >/dev/null ||
    fail "Tcl does not inspect the resolver-owned tclsh"
if awk '/if \[ -n "\$\{WASM_POSIX_DEP_OUT_DIR:-\}" \]; then/,/else/' \
    "$tcl" | grep -F '$SCRIPT_DIR/bin/tclsh.wasm' >/dev/null; then
    fail "Tcl resolver mode still reads a checkout-local output"
fi
awk '/if \[ -n "\$\{WASM_POSIX_DEP_OUT_DIR:-\}" \]; then/,/else/' \
    "$tcl" | grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
    >/dev/null || fail "Tcl sealed install lacks explicit fork policy"

php="$REPO_ROOT/packages/registry/php/build-php.sh"
awk '/if \[ -n "\$\{WASM_POSIX_DEP_OUT_DIR:-\}" \]; then/,/else/' \
    "$php" | grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
    >/dev/null || fail "PHP sealed install lacks explicit fork policy"

msmtpd="$REPO_ROOT/packages/registry/msmtpd/build-msmtpd.sh"
msmtpd_source='https://snapshot.debian.org/archive/debian/20251129T142942Z/pool/main/m/msmtp/msmtp_1.8.32.orig.tar.xz'
grep -F 'SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-'"$msmtpd_source"'}"' \
    "$msmtpd" >/dev/null ||
    fail "msmtpd build does not accept its immutable manifest-owned source"
grep -F 'url = "'"$msmtpd_source"'"' \
    "$REPO_ROOT/packages/registry/msmtpd/package.toml" >/dev/null ||
    fail "msmtpd manifest does not use its immutable source snapshot"

glue="$TEST_ROOT/glue"
mkdir -p "$glue"
: >"$glue/channel_syscall.o"
: >"$glue/compiler_rt.o"
driver="$TEST_ROOT/driver.cmake"
cat >"$driver" <<'CMAKE'
include("${CONTRACT}")
kandelo_mariadb_glue_object_flags(result)
file(WRITE "${RESULT}" "${result}")
CMAKE
cmake \
    -DCONTRACT="$REPO_ROOT/packages/registry/mariadb/mariadb-glue-object-contract.cmake" \
    -DRESULT="$TEST_ROOT/result" \
    -DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$glue" \
    -P "$driver"
grep -F "$glue/channel_syscall.o" "$TEST_ROOT/result" >/dev/null ||
    fail "MariaDB glue contract omitted channel_syscall.o"
grep -F "$glue/compiler_rt.o" "$TEST_ROOT/result" >/dev/null ||
    fail "MariaDB glue contract omitted compiler_rt.o"

symlink_glue="$TEST_ROOT/symlink-glue"
mkdir -p "$symlink_glue"
ln -s "$glue/channel_syscall.o" "$symlink_glue/channel_syscall.o"
cp "$glue/compiler_rt.o" "$symlink_glue/compiler_rt.o"
for bad in missing relative symlink; do
    err="$TEST_ROOT/$bad.err"
    args=()
    if [ "$bad" = relative ]; then
        args=(-DWASM_POSIX_MARIADB_GLUE_OBJ_DIR=relative)
    elif [ "$bad" = symlink ]; then
        args=(-DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$symlink_glue")
    fi
    if cmake \
        -DCONTRACT="$REPO_ROOT/packages/registry/mariadb/mariadb-glue-object-contract.cmake" \
        -DRESULT="$TEST_ROOT/$bad.result" \
        "${args[@]}" \
        -P "$driver" >"$TEST_ROOT/$bad.out" 2>"$err"; then
        fail "MariaDB glue contract accepted $bad authority"
    fi
done

grep -F -- '-DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$GLUE_OBJ_DIR"' \
    "$REPO_ROOT/packages/registry/mariadb/build-mariadb.sh" >/dev/null ||
    fail "MariaDB build does not pass its resolver-owned glue directory"

mariadb="$REPO_ROOT/packages/registry/mariadb/build-mariadb.sh"
awk '/if \[ -n "\$\{WASM_POSIX_DEP_OUT_DIR:-\}" \]; then/,/else/' \
    "$mariadb" | grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
    >/dev/null || fail "MariaDB sealed install lacks explicit fork policy"

try_compile_source="$TEST_ROOT/mariadb-glue-try-compile"
try_compile_sysroot="$TEST_ROOT/mariadb-glue-sysroot"
mkdir -p "$try_compile_source" "$try_compile_sysroot/lib"
: >"$try_compile_sysroot/lib/libc.a"
cat >"$try_compile_source/CMakeLists.txt" <<'CMAKE'
cmake_minimum_required(VERSION 3.13)
project(mariadb_glue_try_compile C)
CMAKE

for arch in wasm32 wasm64; do
    toolchain="$REPO_ROOT/packages/registry/mariadb/$arch-posix-toolchain.cmake"
    grep -F 'mariadb-glue-object-contract.cmake' "$toolchain" >/dev/null ||
        fail "MariaDB $arch toolchain does not load the glue contract"
    if grep -F '_TOOLCHAIN_DIR2' "$toolchain" >/dev/null; then
        fail "MariaDB $arch toolchain still infers checkout-local glue objects"
    fi
    if ! WASM_POSIX_SYSROOT="$try_compile_sysroot" cmake \
        -S "$try_compile_source" \
        -B "$TEST_ROOT/$arch-try-compile" \
        -DCMAKE_TOOLCHAIN_FILE="$toolchain" \
        -DWASM_POSIX_SYSROOT="$try_compile_sysroot" \
        -DWASM_POSIX_MARIADB_GLUE_OBJ_DIR="$glue" \
        >"$TEST_ROOT/$arch-try-compile.out" \
        2>"$TEST_ROOT/$arch-try-compile.err"; then
        cat "$TEST_ROOT/$arch-try-compile.err" >&2
        fail "MariaDB $arch compiler probe lost its prepared glue directory"
    fi
done

grep -F '"packages/registry/mariadb/mariadb-glue-object-contract.cmake"' \
    "$REPO_ROOT/packages/registry/mariadb/build.toml" >/dev/null ||
    fail "MariaDB build provenance omits the glue contract"

echo "test-package-isolated-output-contracts: PASS"
