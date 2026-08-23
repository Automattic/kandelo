#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
TEST_ROOT=$(mktemp -d)
TEST_ROOT=$(cd "$TEST_ROOT" && pwd -P)
trap 'chmod -R u+rwX "$TEST_ROOT" 2>/dev/null || true; rm -rf "$TEST_ROOT"' EXIT

fail() {
    echo "test-package-isolated-output-contracts: $*" >&2
    exit 1
}

tree_digest() {
    local root="$1"
    tar cf - -C "$root" . | shasum -a 256 | awk '{print $1}'
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
php_fork_abi="$REPO_ROOT/packages/registry/php/fork-side-module-abi.c"
[ -f "$php_fork_abi" ] ||
    fail "PHP lacks the ABI identity source for its fork-instrumented side module"
grep -F 'export_name("__abi_version")' "$php_fork_abi" >/dev/null ||
    fail "PHP side-module ABI identity does not export __abi_version"
grep -F 'return WASM_POSIX_ABI_VERSION;' "$php_fork_abi" >/dev/null ||
    fail "PHP side-module ABI identity is not generated from the current ABI header"
grep -F '"$SCRIPT_DIR/fork-side-module-abi.c"' "$php" >/dev/null ||
    fail "PHP build does not compile its reviewed side-module ABI identity source"
grep -F '"$FORK_SIDE_MODULE_ABI_OBJECT"' "$php" >/dev/null ||
    fail "PHP opcache link omits its fork side-module ABI identity object"

spidermonkey="$REPO_ROOT/packages/registry/spidermonkey/build-spidermonkey.sh"
grep -F 'if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then' \
    "$spidermonkey" >/dev/null ||
    fail "SpiderMonkey does not publish its Node runtime to resolver output"
grep -F 'install_local_binary spidermonkey-node "$BIN_DIR/node.wasm" node.wasm' \
    "$spidermonkey" >/dev/null ||
    fail "SpiderMonkey resolver output omits node.wasm"
grep -F 'WASM_POSIX_DEP_WORK_DIR' "$spidermonkey" >/dev/null ||
    fail "SpiderMonkey sealed builds do not use the resolver work root"
grep -F 'WASM_POSIX_DEP_SOURCE_DIR' "$spidermonkey" >/dev/null ||
    fail "SpiderMonkey sealed builds do not use the Formula-owned source"
grep -F 'source "$REPO_ROOT/scripts/package-build-roots.sh"' \
    "$spidermonkey" >/dev/null ||
    fail "SpiderMonkey does not load the verified-source staging contract"
grep -F 'kandelo_package_stage_verified_source spidermonkey' \
    "$spidermonkey" >/dev/null ||
    fail "SpiderMonkey patches the resolver-owned source instead of a caller-owned copy"
grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
    "$spidermonkey" >/dev/null ||
    fail "SpiderMonkey sealed install lacks explicit fork policy auto"
if grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled' \
    "$spidermonkey" >/dev/null; then
    fail "SpiderMonkey build still disables fork instrumentation"
fi

spidermonkey_node="$REPO_ROOT/packages/registry/spidermonkey-node/build-spidermonkey-node.sh"
grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
    "$spidermonkey_node" >/dev/null ||
    fail "SpiderMonkey Node install lacks explicit fork policy auto"
if grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled' \
    "$spidermonkey_node" >/dev/null; then
    fail "SpiderMonkey Node build still disables fork instrumentation"
fi
for manifest in \
    "$REPO_ROOT/packages/registry/spidermonkey/package.toml" \
    "$REPO_ROOT/packages/registry/spidermonkey-node/package.toml" \
    "$REPO_ROOT/packages/registry/node/package.toml"; do
    grep -F 'fork_instrumentation = "auto"' "$manifest" >/dev/null ||
        fail "$(basename "$(dirname "$manifest")") manifest does not require fork instrumentation"
done

perl="$REPO_ROOT/packages/registry/perl/build-perl.sh"
awk '/if \[ -n "\$\{WASM_POSIX_DEP_OUT_DIR:-\}" \]; then/,/else/' \
    "$perl" | grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
    >/dev/null || fail "Perl sealed install lacks explicit fork policy"

fake_bin="$TEST_ROOT/fake-bin"
mkdir "$fake_bin"
cat >"$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
: >"${KANDELO_UNEXPECTED_CURL:?}"
exit 97
SH
chmod 0755 "$fake_bin/curl"

spidermonkey_work="$TEST_ROOT/spidermonkey-work"
spidermonkey_out="$TEST_ROOT/spidermonkey-out"
mkdir "$spidermonkey_work" "$spidermonkey_out"
spidermonkey_curl="$TEST_ROOT/spidermonkey-curl"
if env \
    PATH="$fake_bin:$PATH" \
    KANDELO_UNEXPECTED_CURL="$spidermonkey_curl" \
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_DEP_WORK_DIR="$spidermonkey_work" \
    WASM_POSIX_DEP_OUT_DIR="$spidermonkey_out" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    bash "$spidermonkey" >"$TEST_ROOT/spidermonkey-missing.out" \
        2>"$TEST_ROOT/spidermonkey-missing.err"; then
    fail "SpiderMonkey accepted missing SourceOnly source authority"
fi
grep -F 'SpiderMonkey SourceOnly resolver source is empty' \
    "$TEST_ROOT/spidermonkey-missing.err" >/dev/null ||
    fail "SpiderMonkey missing SourceOnly authority did not fail at admission"
[ ! -e "$spidermonkey_curl" ] ||
    fail "SpiderMonkey fetched before rejecting missing SourceOnly authority"
[ -z "$(find "$spidermonkey_work" -mindepth 1 -print -quit)" ] ||
    fail "SpiderMonkey mutated work state before rejecting missing SourceOnly authority"

# Exercise the successful SourceOnly path with a tiny source tree.  The fake
# patch and mach boundaries make a dead staging call, or resetting SRC_DIR to
# the resolver-owned source after staging, fail observably without compiling
# SpiderMonkey again.
spidermonkey_valid_source="$TEST_ROOT/spidermonkey-valid-source"
spidermonkey_valid_work="$TEST_ROOT/spidermonkey-valid-work"
spidermonkey_valid_out="$TEST_ROOT/spidermonkey-valid-out"
spidermonkey_valid_sysroot="$TEST_ROOT/spidermonkey-valid-sysroot"
spidermonkey_valid_libcxx="$TEST_ROOT/spidermonkey-valid-libcxx"
spidermonkey_valid_openssl="$TEST_ROOT/spidermonkey-valid-openssl"
spidermonkey_valid_zlib="$TEST_ROOT/spidermonkey-valid-zlib"
spidermonkey_valid_archive="$TEST_ROOT/spidermonkey-valid.source.tar.xz"
spidermonkey_patch_marker="$TEST_ROOT/spidermonkey-valid-patch"
spidermonkey_mach_marker="$TEST_ROOT/spidermonkey-valid-mach"
mkdir -p \
    "$spidermonkey_valid_source/js/src/shell" \
    "$spidermonkey_valid_work" \
    "$spidermonkey_valid_out" \
    "$spidermonkey_valid_sysroot/lib" \
    "$spidermonkey_valid_libcxx/lib" \
    "$spidermonkey_valid_libcxx/include/c++/v1" \
    "$spidermonkey_valid_openssl/lib" \
    "$spidermonkey_valid_openssl/include" \
    "$spidermonkey_valid_zlib/lib" \
    "$spidermonkey_valid_zlib/include"
printf 'sealed-source\n' >"$spidermonkey_valid_source/source-marker"
cat >"$spidermonkey_valid_source/mach" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$PWD" = "${KANDELO_EXPECTED_STAGED_SOURCE:?}" ] || exit 91
[ "$(cat source-marker)" = staged-copy ] || exit 92
[ "$(cat "${KANDELO_EXPECTED_SEALED_SOURCE:?}/source-marker")" = sealed-source ] || exit 93
obj_dir="$(sed -n 's/^mk_add_options MOZ_OBJDIR=//p' "${MOZCONFIG:?}")"
[ -n "$obj_dir" ] || exit 94
mkdir -p "$obj_dir/dist/bin"
printf '\000asm\001\000\000\000' >"$obj_dir/dist/bin/js.wasm"
: >"${KANDELO_VALID_MACH_MARKER:?}"
SH
chmod 0555 "$spidermonkey_valid_source/mach"
chmod -R a-w "$spidermonkey_valid_source"
: >"$spidermonkey_valid_archive"
for file in \
    "$spidermonkey_valid_sysroot/lib/libc.a" \
    "$spidermonkey_valid_libcxx/lib/libc++.a" \
    "$spidermonkey_valid_libcxx/lib/libc++abi.a" \
    "$spidermonkey_valid_openssl/lib/libssl.a" \
    "$spidermonkey_valid_openssl/lib/libcrypto.a" \
    "$spidermonkey_valid_zlib/lib/libz.a"; do
    : >"$file"
done
spidermonkey_valid_sysroot_before="$(tree_digest "$spidermonkey_valid_sysroot")"
cat >"$fake_bin/patch" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
dest=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = -d ]; then
        shift
        dest="${1:-}"
    fi
    shift || true
done
[ "$dest" = "${KANDELO_EXPECTED_STAGED_SOURCE:?}" ] || exit 95
[ "$(cat "${KANDELO_EXPECTED_SEALED_SOURCE:?}/source-marker")" = sealed-source ] || exit 96
printf 'staged-copy\n' >"$dest/source-marker"
: >"${KANDELO_VALID_PATCH_MARKER:?}"
# A failed dry run skips applying the real upstream patch in this tiny fixture.
exit 1
SH
chmod 0755 "$fake_bin/patch"
env \
    PATH="$fake_bin:$PATH" \
    KANDELO_EXPECTED_SEALED_SOURCE="$spidermonkey_valid_source" \
    KANDELO_EXPECTED_STAGED_SOURCE="$spidermonkey_valid_work/spidermonkey-source" \
    KANDELO_VALID_PATCH_MARKER="$spidermonkey_patch_marker" \
    KANDELO_VALID_MACH_MARKER="$spidermonkey_mach_marker" \
    WASM_OPT=spidermonkey-test-no-wasm-opt \
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_DEP_WORK_DIR="$spidermonkey_valid_work" \
    WASM_POSIX_DEP_OUT_DIR="$spidermonkey_valid_out" \
    WASM_POSIX_DEP_SOURCE_DIR="$spidermonkey_valid_source" \
    WASM_POSIX_DEP_SOURCE_ARCHIVE="$spidermonkey_valid_archive" \
    WASM_POSIX_DEP_SOURCE_URL=https://invalid.example/spidermonkey-source.tar.xz \
    WASM_POSIX_DEP_SOURCE_SHA256=0000000000000000000000000000000000000000000000000000000000000000 \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_SYSROOT="$spidermonkey_valid_sysroot" \
    WASM_POSIX_DEP_LIBCXX_DIR="$spidermonkey_valid_libcxx" \
    WASM_POSIX_DEP_OPENSSL_DIR="$spidermonkey_valid_openssl" \
    WASM_POSIX_DEP_ZLIB_DIR="$spidermonkey_valid_zlib" \
    bash "$spidermonkey" >"$TEST_ROOT/spidermonkey-valid.out" \
        2>"$TEST_ROOT/spidermonkey-valid.err" || {
        cat "$TEST_ROOT/spidermonkey-valid.err" >&2
        fail "SpiderMonkey valid SourceOnly staging fixture failed"
    }
[ -f "$spidermonkey_patch_marker" ] ||
    fail "SpiderMonkey valid path did not reach the staged-source patch boundary"
[ -f "$spidermonkey_mach_marker" ] ||
    fail "SpiderMonkey valid path did not build from the staged source"
[ "$(cat "$spidermonkey_valid_source/source-marker")" = sealed-source ] ||
    fail "SpiderMonkey valid path mutated the resolver-owned source"
[ "$(cat "$spidermonkey_valid_work/spidermonkey-source/source-marker")" = staged-copy ] ||
    fail "SpiderMonkey valid path did not mutate its caller-owned source copy"
[ -f "$spidermonkey_valid_out/js.wasm" ] &&
    [ -f "$spidermonkey_valid_out/node.wasm" ] ||
    fail "SpiderMonkey valid SourceOnly path did not publish both declared outputs"
spidermonkey_valid_sysroot_after="$(tree_digest "$spidermonkey_valid_sysroot")"
[ "$spidermonkey_valid_sysroot_after" = "$spidermonkey_valid_sysroot_before" ] ||
    fail "SpiderMonkey SourceOnly build mutated its shared SDK sysroot"
spidermonkey_private_sysroot="$(find "$spidermonkey_valid_work" -mindepth 1 -maxdepth 1 \
    -type d -name '.kandelo-spidermonkey-sysroot.*' -print -quit)"
[ -n "$spidermonkey_private_sysroot" ] ||
    fail "SpiderMonkey SourceOnly build did not create a work-owned private sysroot"
[ -L "$spidermonkey_private_sysroot/lib/libc++.a" ] ||
    fail "SpiderMonkey private sysroot omitted the libcxx overlay"
[ -L "$spidermonkey_private_sysroot/lib/libssl.a" ] ||
    fail "SpiderMonkey private sysroot omitted the OpenSSL overlay"
[ -L "$spidermonkey_private_sysroot/lib/libz.a" ] ||
    fail "SpiderMonkey private sysroot omitted the zlib overlay"

perl_work="$TEST_ROOT/perl-work"
perl_out="$TEST_ROOT/perl-out"
perl_source="$TEST_ROOT/perl-source"
perl_git="$TEST_ROOT/perl-cross"
perl_archive="$TEST_ROOT/perl.tar.gz"
mkdir "$perl_work" "$perl_out" "$perl_source" "$perl_git"
: >"$perl_archive"
for perl_case in missing mismatch; do
    perl_curl="$TEST_ROOT/perl-$perl_case-curl"
    perl_args=(
        PATH="$fake_bin:$PATH"
        KANDELO_UNEXPECTED_CURL="$perl_curl"
        WASM_POSIX_RESOLUTION_POLICY=source-only-v1
        WASM_POSIX_DEP_WORK_DIR="$perl_work"
        WASM_POSIX_DEP_OUT_DIR="$perl_out"
        WASM_POSIX_DEP_SOURCE_DIR="$perl_source"
        WASM_POSIX_DEP_SOURCE_ARCHIVE="$perl_archive"
        WASM_POSIX_DEP_TARGET_ARCH=wasm32
    )
    if [ "$perl_case" = mismatch ]; then
        perl_args+=(
            WASM_POSIX_BUILD_GIT_PERL_CROSS_DIR="$perl_git"
            WASM_POSIX_BUILD_GIT_PERL_CROSS_COMMIT=0000000000000000000000000000000000000000
        )
    fi
    if env "${perl_args[@]}" bash "$perl" \
        >"$TEST_ROOT/perl-$perl_case.out" \
        2>"$TEST_ROOT/perl-$perl_case.err"; then
        fail "Perl accepted $perl_case SourceOnly perl-cross authority"
    fi
    grep -F 'Perl SourceOnly requires the exact perl_cross Git input' \
        "$TEST_ROOT/perl-$perl_case.err" >/dev/null ||
        fail "Perl $perl_case Git input did not fail at admission"
    [ ! -e "$perl_curl" ] ||
        fail "Perl fetched before rejecting $perl_case Git input authority"
done

# A small successful sealed install binds Perl's explicit `auto` policy to the
# real install call.  If the assignment is detached or moved to an irrelevant
# command, install-local-binary rejects the otherwise-valid fixture Wasm.
perl_valid_work="$TEST_ROOT/perl-valid-work"
perl_valid_out="$TEST_ROOT/perl-valid-out"
perl_valid_git="$TEST_ROOT/perl-valid-cross"
perl_valid_sysroot="$TEST_ROOT/perl-valid-sysroot"
perl_valid_repo="$TEST_ROOT/perl-valid-repo"
perl_policy_marker="$TEST_ROOT/perl-valid-policy"
mkdir -p \
    "$perl_valid_work/source" "$perl_valid_out" "$perl_valid_git" \
    "$perl_valid_sysroot/lib" \
    "$perl_valid_repo/packages/registry/perl" "$perl_valid_repo/scripts" \
    "$perl_valid_repo/sdk"
cp "$perl" "$perl_valid_repo/packages/registry/perl/build-perl.sh"
ln -s "$REPO_ROOT/scripts/package-build-roots.sh" \
    "$perl_valid_repo/scripts/package-build-roots.sh"
cat >"$perl_valid_repo/sdk/activate.sh" <<'SH'
#!/usr/bin/env bash
:
SH
cat >"$perl_valid_repo/scripts/install-local-binary.sh" <<'SH'
#!/usr/bin/env bash
source "${KANDELO_REAL_INSTALL_SCRIPT:?}"
eval "$(declare -f install_local_binary | sed \
    '1s/install_local_binary/_kandelo_real_install_local_binary/')"
install_local_binary() {
    if [ "${WASM_POSIX_INSTALL_FORK_INSTRUMENTATION:-}" != auto ]; then
        echo "fixture: Perl install did not bind fork policy auto" >&2
        return 98
    fi
    : >"${KANDELO_PERL_POLICY_MARKER:?}"
    _kandelo_real_install_local_binary "$@"
}
SH
printf '\000asm\001\000\000\000' >"$perl_valid_work/source/perl"
: >"$perl_valid_work/source/config.sh"
: >"$perl_valid_sysroot/lib/libc.a"
cat >"$fake_bin/make" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ -f ./perl ] || exit 97
exit 0
SH
chmod 0755 "$fake_bin/make"
cat >"$fake_bin/wasm32posix-cc" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod 0755 "$fake_bin/wasm32posix-cc"
env \
    PATH="$fake_bin:$PATH" \
    KANDELO_REAL_INSTALL_SCRIPT="$REPO_ROOT/scripts/install-local-binary.sh" \
    KANDELO_PERL_POLICY_MARKER="$perl_policy_marker" \
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_DEP_WORK_DIR="$perl_valid_work" \
    WASM_POSIX_DEP_OUT_DIR="$perl_valid_out" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_SYSROOT="$perl_valid_sysroot" \
    WASM_POSIX_BUILD_GIT_PERL_CROSS_DIR="$perl_valid_git" \
    WASM_POSIX_BUILD_GIT_PERL_CROSS_COMMIT=0cc3a1c5432cab8f121f7a629f61893713e7d27a \
    bash "$perl_valid_repo/packages/registry/perl/build-perl.sh" \
        >"$TEST_ROOT/perl-valid.out" \
        2>"$TEST_ROOT/perl-valid.err" || {
        cat "$TEST_ROOT/perl-valid.out" >&2
        cat "$TEST_ROOT/perl-valid.err" >&2
        fail "Perl valid SourceOnly fork-policy fixture failed"
    }
[ -f "$perl_valid_out/perl.wasm" ] ||
    fail "Perl valid SourceOnly path did not publish perl.wasm"
[ -f "$perl_policy_marker" ] ||
    fail "Perl valid SourceOnly install did not execute with fork policy auto"

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
grep -F 'PCRE2_PREFIX="${WASM_POSIX_DEP_PCRE2_DIR:-}"' "$mariadb" >/dev/null ||
    fail "MariaDB cannot consume the exact pcre2 bottle prefix"
grep -F '"$PCRE2_PREFIX/lib/libpcre2-8.a"' "$mariadb" >/dev/null ||
    fail "MariaDB does not validate the pcre2 bottle library"
grep -F '"$PCRE2_PREFIX/include/pcre2posix.h"' "$mariadb" >/dev/null ||
    fail "MariaDB does not validate the pcre2 bottle headers"
grep -F 'MARIADB_VFS_SOURCE_ROLES' "$mariadb" >/dev/null ||
    fail "MariaDB does not expose source roles to a sealed Formula build"
grep -F 'PCRE2_SOURCE_DIR="$(kandelo_package_source_dependency_dir pcre2-source)"' \
    "$mariadb" >/dev/null ||
    fail "MariaDB SourceOnly build bypasses its resolver-injected pcre2 source"

# MariaDB must cross-compile against a work-owned private sysroot. Exercise the
# real recipe up to its cross-CMake boundary while a synchronized competitor
# removes libc++ from the selected SDK seed. The private projection must retain
# libc++ and the shared seed must not receive package headers or libraries.
mariadb_fixture="$TEST_ROOT/mariadb-private-sysroot"
mariadb_repo="$mariadb_fixture/repo"
mariadb_recipe="$mariadb_repo/packages/registry/mariadb"
mariadb_source="$mariadb_fixture/source"
mariadb_work="$mariadb_fixture/work"
mariadb_out="$mariadb_fixture/out"
mariadb_seed="$mariadb_fixture/sysroot"
mariadb_libcxx="$mariadb_fixture/libcxx"
mariadb_pcre2="$mariadb_fixture/pcre2"
mariadb_fake_bin="$mariadb_fixture/fake-bin"
mariadb_fake_llvm="$mariadb_fixture/llvm"
mkdir -p \
    "$mariadb_recipe" \
    "$mariadb_repo/scripts" \
    "$mariadb_repo/sdk" \
    "$mariadb_repo/libc/glue" \
    "$mariadb_source" \
    "$mariadb_work/source" \
    "$mariadb_work/source/mysys" \
    "$mariadb_work/source/scripts" \
    "$mariadb_work/host-build/extra" \
    "$mariadb_work/host-build/scripts" \
    "$mariadb_work/host-build/dbug" \
    "$mariadb_work/host-build/sql" \
    "$mariadb_work/cross-build" \
    "$mariadb_out" \
    "$mariadb_seed/lib" \
    "$mariadb_seed/include/c++/v1" \
    "$mariadb_libcxx/lib" \
    "$mariadb_libcxx/include/c++/v1" \
    "$mariadb_pcre2/lib" \
    "$mariadb_pcre2/include" \
    "$mariadb_fake_bin" \
    "$mariadb_fake_llvm/bin"
cp "$mariadb" "$mariadb_recipe/build-mariadb.sh"
cp "$REPO_ROOT/packages/registry/mariadb/wasm32-posix-toolchain.cmake" \
    "$mariadb_recipe/wasm32-posix-toolchain.cmake"
ln -s "$REPO_ROOT/scripts/package-build-roots.sh" \
    "$mariadb_repo/scripts/package-build-roots.sh"
cat >"$mariadb_repo/sdk/activate.sh" <<'SH'
#!/usr/bin/env bash
:
SH
: >"$mariadb_repo/libc/glue/channel_syscall.c"
: >"$mariadb_repo/libc/glue/compiler_rt.c"
printf '__wasm32__\n' >"$mariadb_work/source/mysys/my_gethwaddr.c"
printf 'system tables\n' \
    >"$mariadb_work/source/scripts/mysql_system_tables.sql"
printf 'system table data\n' \
    >"$mariadb_work/source/scripts/mysql_system_tables_data.sql"
: >"$mariadb_seed/lib/libc.a"
: >"$mariadb_seed/lib/crt1.o"
printf 'seed atomic\n' >"$mariadb_seed/include/c++/v1/atomic"
: >"$mariadb_libcxx/lib/libc++.a"
: >"$mariadb_libcxx/lib/libc++abi.a"
printf 'private atomic\n' >"$mariadb_libcxx/include/c++/v1/atomic"
printf 'cached-sysroot=%s\n' "$mariadb_seed" \
    >"$mariadb_work/cross-build/CMakeCache.txt"
: >"$mariadb_pcre2/lib/libpcre2-8.a"
: >"$mariadb_pcre2/lib/libpcre2-posix.a"
: >"$mariadb_pcre2/include/pcre2.h"
: >"$mariadb_pcre2/include/pcre2posix.h"
: >"$mariadb_work/host-build/import_executables.cmake"
for helper in \
    extra/comp_err scripts/comp_sql dbug/factorial \
    sql/gen_lex_hash sql/gen_lex_token; do
    : >"$mariadb_work/host-build/$helper"
    chmod 0755 "$mariadb_work/host-build/$helper"
done

cat >"$mariadb_fake_llvm/bin/clang" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then
        output="$2"
        shift 2
    else
        shift
    fi
done
[ -n "$output" ] || exit 72
: >"$output"
SH
for tool in llvm-ar llvm-ranlib llvm-nm; do
    cat >"$mariadb_fake_llvm/bin/$tool" <<'SH'
#!/usr/bin/env bash
exit 0
SH
done
cat >"$mariadb_fake_bin/bison" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$mariadb_fake_bin/cmake" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
: >"${MARIADB_COMPETITOR_START:?}"
attempt=0
while [ ! -e "${MARIADB_COMPETITOR_DONE:?}" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 1000 ] || exit 73
    sleep 0.01
done
if [ -e "${EXPECTED_MARIADB_CROSS_BUILD:?}/CMakeCache.txt" ]; then
    echo "fixture: MariaDB reused its stale cross CMake cache" >&2
    exit 78
fi
case "${WASM_POSIX_SYSROOT:?}/" in
    "${EXPECTED_MARIADB_WORK:?}/.kandelo-mariadb-sysroot."*/) ;;
    *) exit 74 ;;
esac
[ "$WASM_POSIX_SYSROOT" != "${EXPECTED_MARIADB_SEED:?}" ] || exit 75
[ -f "$WASM_POSIX_SYSROOT/include/c++/v1/atomic" ] || exit 76
printf 'configured-sysroot=%s\n' "$WASM_POSIX_SYSROOT" \
    >"$EXPECTED_MARIADB_CROSS_BUILD/CMakeCache.txt"
printf '%s\n' "$WASM_POSIX_SYSROOT" >"${OBSERVED_MARIADB_SYSROOT:?}"
exit 0
SH
cat >"$mariadb_fake_bin/make" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" mariadbd "*)
    mkdir -p sql
    printf 'fixture mariadbd\n' >sql/mariadbd
    ;;
  *" mariadb-test "*)
    mkdir -p client
    printf 'fixture mysqltest\n' >client/mariadb-test
    ;;
  *) exit 79 ;;
esac
SH
cat >"$mariadb_repo/scripts/install-local-binary.sh" <<'SH'
#!/usr/bin/env bash
install_local_binary() {
    [ "${WASM_POSIX_INSTALL_LOCAL_MIRROR:-}" = 0 ] || return 80
    cp "$2" "${WASM_POSIX_DEP_OUT_DIR:?}/$3"
}
install_local_runtime_file() {
    [ "${WASM_POSIX_INSTALL_LOCAL_MIRROR:-}" = 0 ] || return 81
    mkdir -p "${WASM_POSIX_DEP_OUT_DIR:?}/$(dirname "$3")"
    cp "$2" "$WASM_POSIX_DEP_OUT_DIR/$3"
}
SH
chmod 0755 \
    "$mariadb_repo/sdk/activate.sh" \
    "$mariadb_fake_llvm/bin/clang" \
    "$mariadb_fake_llvm/bin/llvm-ar" \
    "$mariadb_fake_llvm/bin/llvm-ranlib" \
    "$mariadb_fake_llvm/bin/llvm-nm" \
    "$mariadb_fake_bin/bison" \
    "$mariadb_fake_bin/cmake" \
    "$mariadb_fake_bin/make"

mariadb_competitor_start="$mariadb_fixture/competitor-start"
mariadb_competitor_done="$mariadb_fixture/competitor-done"
(
    attempt=0
    while [ ! -e "$mariadb_competitor_start" ]; do
        attempt=$((attempt + 1))
        [ "$attempt" -lt 1000 ] || exit 77
        sleep 0.01
    done
    rm -rf "$mariadb_seed/include/c++/v1"
    : >"$mariadb_competitor_done"
) &
mariadb_competitor_pid=$!
set +e
env \
    PATH="$mariadb_fake_bin:$PATH" \
    LLVM_PREFIX="$mariadb_fake_llvm" \
    EXPECTED_MARIADB_WORK="$mariadb_work" \
    EXPECTED_MARIADB_CROSS_BUILD="$mariadb_work/cross-build" \
    EXPECTED_MARIADB_SEED="$mariadb_seed" \
    MARIADB_COMPETITOR_START="$mariadb_competitor_start" \
    MARIADB_COMPETITOR_DONE="$mariadb_competitor_done" \
    OBSERVED_MARIADB_SYSROOT="$mariadb_fixture/observed-sysroot" \
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_DEP_NAME=mariadb \
    WASM_POSIX_DEP_VERSION=10.5.28 \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_DEP_WORK_DIR="$mariadb_work" \
    WASM_POSIX_DEP_OUT_DIR="$mariadb_out" \
    WASM_POSIX_DEP_SOURCE_DIR="$mariadb_source" \
    WASM_POSIX_DEP_LIBCXX_DIR="$mariadb_libcxx" \
    WASM_POSIX_DEP_PCRE2_DIR="$mariadb_pcre2" \
    WASM_POSIX_SYSROOT="$mariadb_seed" \
    bash "$mariadb_recipe/build-mariadb.sh" \
        >"$mariadb_fixture/stdout" 2>"$mariadb_fixture/stderr"
mariadb_status=$?
set -e
if ! wait "$mariadb_competitor_pid"; then
    cat "$mariadb_fixture/stdout" >&2
    cat "$mariadb_fixture/stderr" >&2
    fail "MariaDB sysroot competitor did not complete"
fi
[ "$mariadb_status" -eq 0 ] || {
    cat "$mariadb_fixture/stdout" >&2
    cat "$mariadb_fixture/stderr" >&2
    fail "MariaDB cross build did not retain libcxx in a work-owned private sysroot"
}
for runtime_member in \
    share/mysql/mysql_system_tables.sql \
    share/mysql/mysql_system_tables_data.sql; do
    [ -f "$mariadb_out/$runtime_member" ] ||
        fail "MariaDB resolver output omitted declared runtime member $runtime_member"
done
mariadb_observed_sysroot="$(cat "$mariadb_fixture/observed-sysroot")"
[ "$(cat "$mariadb_observed_sysroot/include/c++/v1/atomic")" = \
    'private atomic' ] ||
    fail "MariaDB private sysroot did not retain declared libcxx contents"
grep -F "configured-sysroot=$mariadb_observed_sysroot" \
    "$mariadb_work/cross-build/CMakeCache.txt" >/dev/null ||
    fail "MariaDB cross CMake cache did not bind the private sysroot"
if grep -F "$mariadb_seed" \
    "$mariadb_work/cross-build/CMakeCache.txt" >/dev/null; then
    fail "MariaDB cross CMake cache retained the shared sysroot"
fi
[ ! -e "$mariadb_seed/include/c++/v1" ] ||
    fail "MariaDB fixture competitor did not remove the seed libcxx headers"
for shared_path in \
    "$mariadb_seed/lib/libc++.a" \
    "$mariadb_seed/lib/libc++abi.a" \
    "$mariadb_seed/lib/libpcre2-8.a" \
    "$mariadb_seed/include/pcre2.h"; do
    [ ! -e "$shared_path" ] ||
        fail "MariaDB build mutated shared sysroot path $shared_path"
done

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

# Nano must consume the resolver's declared source, work, output, and ncurses
# roots. Exercise the real recipe in a miniature checkout: any nested resolver
# or source download is trapped, and the fake build mutates only the staged
# source below WORK before publishing the declared artifact below OUT.
nano_fixture="$TEST_ROOT/nano-source-only"
nano_repo="$nano_fixture/repo"
nano_recipe="$nano_repo/packages/registry/nano"
nano_source="$nano_fixture/source"
nano_work="$nano_fixture/work"
nano_out="$nano_fixture/out"
nano_ncurses="$nano_fixture/ncurses"
nano_fake_bin="$nano_fixture/fake-bin"
mkdir -p \
    "$nano_recipe" \
    "$nano_repo/scripts" \
    "$nano_repo/sdk" \
    "$nano_repo/sysroot/lib" \
    "$nano_source/src" \
    "$nano_work" \
    "$nano_out" \
    "$nano_ncurses/lib" \
    "$nano_fake_bin"
cp "$REPO_ROOT/packages/registry/nano/build-nano.sh" "$nano_recipe/build-nano.sh"
ln -s "$REPO_ROOT/scripts/package-build-roots.sh" \
    "$nano_repo/scripts/package-build-roots.sh"
: >"$nano_repo/sysroot/lib/libc.a"
: >"$nano_ncurses/lib/libncursesw.a"
: >"$nano_ncurses/lib/libtinfow.a"
: >"$nano_fixture/source.tar.xz"

cat >"$nano_repo/sdk/activate.sh" <<'SH'
#!/usr/bin/env bash
export KANDELO_FIXTURE_SDK_ACTIVATED=1
SH
cat >"$nano_repo/scripts/install-local-binary.sh" <<'SH'
#!/usr/bin/env bash
install_local_binary() {
    test "$1" = nano
    test "$3" = nano.wasm
    test "${WASM_POSIX_INSTALL_LOCAL_MIRROR:-}" = 0
    test "${WASM_POSIX_INSTALL_FORK_INSTRUMENTATION:-}" = auto
    cp "$2" "${WASM_POSIX_DEP_OUT_DIR:?}/$3"
}
SH
cat >"$nano_source/configure" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
test "${KANDELO_FIXTURE_SDK_ACTIVATED:-}" = 1
test "$PWD" = "${EXPECTED_NANO_BUILD_DIR:?}"
if [ "${NCURSESW_CFLAGS:-}" != \
     "-I${EXPECTED_NANO_NCURSES_PREFIX:?}/include" ]; then
    echo "fixture: Nano configure lost resolver ncurses include flags" >&2
    exit 72
fi
if [ "${NCURSESW_LIBS:-}" != \
     "-L${EXPECTED_NANO_NCURSES_PREFIX:?}/lib -lncursesw -ltinfow" ]; then
    echo "fixture: Nano configure lost resolver ncurses library flags" >&2
    exit 73
fi
printf 'configured\n' >> fixture-source-state
: >Makefile
SH
printf 'sealed\n' >"$nano_source/fixture-source-state"
chmod 0555 "$nano_source/configure"
chmod 0444 "$nano_source/fixture-source-state"
chmod 0555 "$nano_source" "$nano_source/src"

cat >"$nano_fake_bin/wasm32posix-cc" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$nano_fake_bin/wasm32posix-configure" <<'SH'
#!/usr/bin/env bash
exec ./configure "$@"
SH
cat >"$nano_fake_bin/make" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
test "$PWD" = "${EXPECTED_NANO_BUILD_DIR:?}"
mkdir -p src
printf '\0asmfixture-nano\n' >src/nano
SH
for trapped_tool in cargo curl; do
    cat >"$nano_fake_bin/$trapped_tool" <<'SH'
#!/usr/bin/env bash
: >"${KANDELO_UNEXPECTED_TOOL:?}"
exit 97
SH
done
chmod 0755 "$nano_repo/sdk/activate.sh" \
    "$nano_repo/scripts/install-local-binary.sh" \
    "$nano_fake_bin/wasm32posix-cc" \
    "$nano_fake_bin/wasm32posix-configure" \
    "$nano_fake_bin/make" \
    "$nano_fake_bin/cargo" \
    "$nano_fake_bin/curl"

nano_source_before="$({
    find "$nano_source" -type f -exec shasum -a 256 {} \;
} | LC_ALL=C sort)"
if ! env \
    PATH="$nano_fake_bin:$PATH" \
    EXPECTED_NANO_BUILD_DIR="$nano_work/nano-src" \
    EXPECTED_NANO_NCURSES_PREFIX="$nano_ncurses" \
    KANDELO_UNEXPECTED_TOOL="$nano_fixture/unexpected-tool" \
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_DEP_NAME=nano \
    WASM_POSIX_DEP_VERSION=8.0 \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_DEP_WORK_DIR="$nano_work" \
    WASM_POSIX_DEP_OUT_DIR="$nano_out" \
    WASM_POSIX_DEP_SOURCE_ARCHIVE="$nano_fixture/source.tar.xz" \
    WASM_POSIX_DEP_SOURCE_DIR="$nano_source" \
    WASM_POSIX_DEP_SOURCE_URL=https://invalid.example/nano-8.0.tar.xz \
    WASM_POSIX_DEP_SOURCE_SHA256=c17f43fc0e37336b33ee50a209c701d5beb808adc2d9f089ca831b40539c9ac4 \
    WASM_POSIX_DEP_NCURSES_DIR="$nano_ncurses" \
    bash "$nano_recipe/build-nano.sh" \
        >"$nano_fixture/stdout" 2>"$nano_fixture/stderr"; then
    cat "$nano_fixture/stdout" >&2
    cat "$nano_fixture/stderr" >&2
    fail "Nano SourceOnly build ignored resolver-owned source/work/output roots"
fi
[ ! -e "$nano_fixture/unexpected-tool" ] ||
    fail "Nano SourceOnly build invoked curl or a nested resolver"
[ -f "$nano_out/nano.wasm" ] ||
    fail "Nano SourceOnly build did not publish its declared output"
[ -f "$nano_work/nano-src/fixture-source-state" ] ||
    fail "Nano SourceOnly build did not stage source below resolver work"
grep -F 'configured' "$nano_work/nano-src/fixture-source-state" >/dev/null ||
    fail "Nano SourceOnly build did not configure its mutable staged source"
nano_source_after="$({
    find "$nano_source" -type f -exec shasum -a 256 {} \;
} | LC_ALL=C sort)"
[ "$nano_source_after" = "$nano_source_before" ] ||
    fail "Nano SourceOnly build mutated its sealed resolver source"
[ -z "$(find "$nano_source" -perm -u=w -print -quit)" ] ||
    fail "Nano SourceOnly build made its sealed resolver source writable"
[ ! -e "$nano_recipe/nano-src" ] && [ ! -e "$nano_recipe/bin" ] ||
    fail "Nano SourceOnly build mutated its recipe checkout"
[ ! -e "$nano_repo/local-binaries" ] ||
    fail "Nano SourceOnly build wrote a developer local-binaries mirror"

# SourceOnly cannot discover an undeclared dependency by running a nested
# resolver. Missing direct-dependency injection must fail before any tool runs.
nano_missing_work="$nano_fixture/missing-ncurses-work"
nano_missing_out="$nano_fixture/missing-ncurses-out"
mkdir "$nano_missing_work" "$nano_missing_out"
set +e
env \
    PATH="$nano_fake_bin:$PATH" \
    KANDELO_UNEXPECTED_TOOL="$nano_fixture/unexpected-missing-tool" \
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_DEP_NAME=nano \
    WASM_POSIX_DEP_VERSION=8.0 \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_DEP_WORK_DIR="$nano_missing_work" \
    WASM_POSIX_DEP_OUT_DIR="$nano_missing_out" \
    WASM_POSIX_DEP_SOURCE_ARCHIVE="$nano_fixture/source.tar.xz" \
    WASM_POSIX_DEP_SOURCE_DIR="$nano_source" \
    WASM_POSIX_DEP_SOURCE_URL=https://invalid.example/nano-8.0.tar.xz \
    WASM_POSIX_DEP_SOURCE_SHA256=c17f43fc0e37336b33ee50a209c701d5beb808adc2d9f089ca831b40539c9ac4 \
    bash "$nano_recipe/build-nano.sh" \
        >"$nano_fixture/missing.out" 2>"$nano_fixture/missing.err"
nano_missing_status=$?
set -e
[ "$nano_missing_status" -ne 0 ] ||
    fail "Nano SourceOnly build accepted missing declared ncurses injection"
grep -F 'Nano SourceOnly requires resolver-provided ncurses' \
    "$nano_fixture/missing.err" >/dev/null ||
    fail "Nano SourceOnly build did not reject missing ncurses at admission"
[ ! -e "$nano_fixture/unexpected-missing-tool" ] ||
    fail "Nano SourceOnly build nested-resolved or fetched missing ncurses"

grep -F 'depends_on = ["ncurses@6.5"]' \
    "$REPO_ROOT/packages/registry/nano/package.toml" >/dev/null ||
    fail "Nano package metadata omits its direct ncurses@6.5 dependency"

# The resolver owns the OUT_DIR inode. Recipes may populate it, but replacing
# the directory would detach the resolver's no-replace publication authority.
ncurses_fixture="$TEST_ROOT/ncurses-output-root"
ncurses_source="$ncurses_fixture/source"
ncurses_work="$ncurses_fixture/work"
ncurses_out="$ncurses_fixture/out"
ncurses_bin="$ncurses_fixture/bin"
ncurses_archive="$ncurses_fixture/source.tar"
mkdir -p \
    "$ncurses_source" \
    "$ncurses_work/ncurses-host-build/progs" \
    "$ncurses_work/terminfo/x" \
    "$ncurses_out" \
    "$ncurses_bin"
: >"$ncurses_archive"
cat >"$ncurses_source/configure" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if inode="$(stat -f '%i' "$WASM_POSIX_DEP_OUT_DIR" 2>/dev/null)"; then
    :
else
    inode="$(stat -c '%i' "$WASM_POSIX_DEP_OUT_DIR")"
fi
test "$inode" = "$EXPECTED_OUT_INODE"
exit 73
SH
chmod +x "$ncurses_source/configure"
for tool in tic infocmp; do
    cat >"$ncurses_work/ncurses-host-build/progs/$tool" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    chmod +x "$ncurses_work/ncurses-host-build/progs/$tool"
done
: >"$ncurses_work/terminfo/x/xterm-256color"
cat >"$ncurses_bin/wasm32posix-cc" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$ncurses_bin/wasm32posix-cc"
if expected_out_inode="$(stat -f '%i' "$ncurses_out" 2>/dev/null)"; then
    :
else
    expected_out_inode="$(stat -c '%i' "$ncurses_out")"
fi
set +e
PATH="$ncurses_bin:$PATH" \
EXPECTED_OUT_INODE="$expected_out_inode" \
WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
WASM_POSIX_DEP_WORK_DIR="$ncurses_work" \
WASM_POSIX_DEP_OUT_DIR="$ncurses_out" \
WASM_POSIX_DEP_SOURCE_ARCHIVE="$ncurses_archive" \
WASM_POSIX_DEP_SOURCE_DIR="$ncurses_source" \
WASM_POSIX_DEP_VERSION=6.5 \
    bash "$REPO_ROOT/packages/registry/ncurses/build-ncurses.sh" \
    >"$ncurses_fixture/stdout" 2>"$ncurses_fixture/stderr"
ncurses_status=$?
set -e
if [ "$ncurses_status" -ne 73 ]; then
    cat "$ncurses_fixture/stderr" >&2
    fail "ncurses replaced or bypassed the resolver-owned output directory"
fi
if actual_out_inode="$(stat -f '%i' "$ncurses_out" 2>/dev/null)"; then
    :
else
    actual_out_inode="$(stat -c '%i' "$ncurses_out")"
fi
[ "$actual_out_inode" = "$expected_out_inode" ] ||
    fail "ncurses replaced the resolver-owned output directory inode"

# SourceOnly recipes share the immutable SDK sysroot as an input, but resolver
# builds must not use it as a mutable dependency staging area. Exercise the
# two legacy compressor recipes at their real post-build installation boundary:
# their declared Wasm output remains resolver-owned while their old shared
# library side effect is suppressed only for resolver invocations.
assert_compressor_sysroot_isolation() {
    local package="$1"
    local fixture="$TEST_ROOT/$package-sysroot-race"
    local repo="$fixture/repo"
    local recipe_dir="$repo/packages/registry/$package"
    local seed="$repo/sysroot"
    local work="$fixture/work"
    local out="$fixture/out"
    local fake_bin="$fixture/fake-bin"
    local recipe="$recipe_dir/build-$package.sh"
    local before after

    mkdir -p "$recipe_dir" "$repo/scripts" "$seed/lib" "$seed/include" \
        "$work" "$out" "$fake_bin"
    cp "$REPO_ROOT/packages/registry/$package/build-$package.sh" "$recipe"
    cat >"$repo/scripts/install-local-binary.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
install_local_binary() {
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        cp "$2" "$WASM_POSIX_DEP_OUT_DIR/$(basename "$2")"
    fi
}
SH
    chmod 0755 "$repo/scripts/install-local-binary.sh"
    cat >"$fake_bin/wasm32posix-cc" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    cat >"$fake_bin/make" <<'SH'
#!/usr/bin/env bash
exit 0
SH
    chmod 0755 "$fake_bin/wasm32posix-cc" "$fake_bin/make"
    : >"$seed/lib/libc.a"
    printf 'shared SDK seed\n' >"$seed/include/seed.h"

    if [ "$package" = bzip2 ]; then
        mkdir -p "$recipe_dir/bzip2-src"
        printf '\000asm\001\000\000\000' >"$recipe_dir/bzip2-src/bzip2"
        : >"$recipe_dir/bzip2-src/libbz2.a"
        printf 'bzip2 header\n' >"$recipe_dir/bzip2-src/bzlib.h"
        local shared_archive="$seed/lib/libbz2.a"
        local shared_header="$seed/include/bzlib.h"
        local output="$out/bzip2.wasm"
    else
        mkdir -p "$recipe_dir/xz-src/src/xz" \
            "$recipe_dir/xz-src/src/liblzma/.libs" \
            "$recipe_dir/xz-src/src/liblzma/api/lzma"
        : >"$recipe_dir/xz-src/Makefile"
        printf '\000asm\001\000\000\000' >"$recipe_dir/xz-src/src/xz/xz"
        : >"$recipe_dir/xz-src/src/liblzma/.libs/liblzma.a"
        printf 'xz header\n' >"$recipe_dir/xz-src/src/liblzma/api/lzma.h"
        printf 'xz subheader\n' >"$recipe_dir/xz-src/src/liblzma/api/lzma/sub.h"
        local shared_archive="$seed/lib/liblzma.a"
        local shared_header="$seed/include/lzma.h"
        local output="$out/xz.wasm"
    fi

    before="$(tree_digest "$seed")"
    if ! env \
        PATH="$fake_bin:$PATH" \
        WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
        WASM_POSIX_DEP_NAME="$package" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        WASM_POSIX_DEP_WORK_DIR="$work" \
        WASM_POSIX_DEP_OUT_DIR="$out" \
        WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        bash "$recipe" >"$fixture/resolver.out" 2>"$fixture/resolver.err"; then
        cat "$fixture/resolver.out" >&2
        cat "$fixture/resolver.err" >&2
        fail "$package resolver fixture failed"
    fi
    after="$(tree_digest "$seed")"
    [ "$after" = "$before" ] ||
        fail "$package resolver build mutated its shared SDK sysroot"
    [ -f "$output" ] ||
        fail "$package resolver build did not publish its declared Wasm output"
    [ ! -e "$shared_archive" ] && [ ! -e "$shared_header" ] ||
        fail "$package resolver build installed its legacy library into the shared sysroot"

    # Direct invocation retains the historical library installation behavior.
    if ! env \
        -u WASM_POSIX_DEP_WORK_DIR \
        -u WASM_POSIX_DEP_OUT_DIR \
        PATH="$fake_bin:$PATH" \
        WASM_POSIX_INSTALL_LOCAL_MIRROR=0 \
        WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        bash "$recipe" >"$fixture/direct.out" 2>"$fixture/direct.err"; then
        cat "$fixture/direct.out" >&2
        cat "$fixture/direct.err" >&2
        fail "$package direct-invocation fixture failed"
    fi
    [ -f "$shared_archive" ] ||
        fail "$package direct invocation stopped installing its shared library"
    [ -f "$shared_header" ] ||
        fail "$package direct invocation stopped installing its shared header"
}

assert_compressor_sysroot_isolation bzip2
assert_compressor_sysroot_isolation xz

# ICU's C++ toolchain projection must be mutable only below the resolver work
# root. Stop at its fetch boundary after the projection so this remains a fast
# behavioral test rather than a second ICU build.
icu_fixture="$TEST_ROOT/icu-sysroot-race"
icu_seed="$icu_fixture/seed"
icu_work="$icu_fixture/work"
icu_out="$icu_fixture/out"
icu_libcxx="$icu_fixture/libcxx"
icu_fake_bin="$icu_fixture/fake-bin"
mkdir -p "$icu_seed/lib" "$icu_seed/include" "$icu_work" "$icu_out" \
    "$icu_libcxx/lib" "$icu_libcxx/include/c++/v1" "$icu_fake_bin"
: >"$icu_seed/lib/libc.a"
printf 'icu shared seed\n' >"$icu_seed/include/seed.h"
: >"$icu_libcxx/lib/libc++.a"
: >"$icu_libcxx/lib/libc++abi.a"
printf 'icu libcxx header\n' >"$icu_libcxx/include/c++/v1/memory"
cat >"$icu_fake_bin/curl" <<'SH'
#!/usr/bin/env bash
: >"${KANDELO_UNEXPECTED_CURL:?}"
exit 97
SH
chmod 0755 "$icu_fake_bin/curl"
icu_before="$(tree_digest "$icu_seed")"
set +e
env \
    PATH="$icu_fake_bin:$PATH" \
    KANDELO_UNEXPECTED_CURL="$icu_fixture/curl-was-called" \
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_DEP_NAME=icu \
    WASM_POSIX_DEP_VERSION=74.2 \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_DEP_WORK_DIR="$icu_work" \
    WASM_POSIX_DEP_OUT_DIR="$icu_out" \
    WASM_POSIX_DEP_LIBCXX_DIR="$icu_libcxx" \
    WASM_POSIX_SYSROOT="$icu_seed" \
    WASM_POSIX_KEEP_BUILD_DIR=1 \
    bash "$REPO_ROOT/packages/registry/icu/build-icu.sh" \
    >"$icu_fixture/stdout" 2>"$icu_fixture/stderr"
icu_status=$?
set -e
[ "$icu_status" -ne 0 ] || fail "ICU fetch-boundary fixture unexpectedly succeeded"
icu_after="$(tree_digest "$icu_seed")"
[ "$icu_after" = "$icu_before" ] ||
    fail "ICU SourceOnly build mutated its shared SDK sysroot"
icu_private_sysroot="$(find "$icu_work" -mindepth 1 -maxdepth 1 \
    -type d -name '.kandelo-icu-sysroot.*' -print -quit)"
[ -n "$icu_private_sysroot" ] ||
    fail "ICU SourceOnly build did not create a work-owned private sysroot"
[ -f "$icu_private_sysroot/lib/libc++.a" ] ||
    fail "ICU private sysroot omitted the libcxx archive"
[ -f "$icu_private_sysroot/include/c++/v1/memory" ] ||
    fail "ICU private sysroot omitted the libcxx headers"

# kandelo-sdk must keep its intermediate glue objects below the resolver work
# root and publish only its declared VFS output. Fake compiler and VFS-builder
# boundaries make those locations observable without building a real VFS.
kandelo_sdk_fixture="$TEST_ROOT/kandelo-sdk-sysroot-race"
kandelo_sdk_repo="$kandelo_sdk_fixture/repo"
kandelo_sdk_recipe_dir="$kandelo_sdk_repo/packages/registry/kandelo-sdk"
kandelo_sdk_seed="$kandelo_sdk_fixture/seed"
kandelo_sdk_work="$kandelo_sdk_fixture/work"
kandelo_sdk_out="$kandelo_sdk_fixture/out"
kandelo_sdk_libcxx="$kandelo_sdk_fixture/libcxx"
kandelo_sdk_fake_bin="$kandelo_sdk_fixture/fake-bin"
mkdir -p "$kandelo_sdk_recipe_dir" "$kandelo_sdk_repo/scripts" \
    "$kandelo_sdk_repo/sdk" "$kandelo_sdk_repo/libc/glue" \
    "$kandelo_sdk_repo/images/vfs/scripts" \
    "$kandelo_sdk_seed/lib" "$kandelo_sdk_seed/include" "$kandelo_sdk_work" \
    "$kandelo_sdk_out" "$kandelo_sdk_libcxx/lib" \
    "$kandelo_sdk_libcxx/include/c++/v1" "$kandelo_sdk_fake_bin"
cp "$REPO_ROOT/packages/registry/kandelo-sdk/build-kandelo-sdk.sh" \
    "$kandelo_sdk_recipe_dir/build-kandelo-sdk.sh"
cp "$REPO_ROOT/scripts/package-build-roots.sh" \
    "$kandelo_sdk_repo/scripts/package-build-roots.sh"
cat >"$kandelo_sdk_repo/sdk/activate.sh" <<'SH'
#!/usr/bin/env bash
:
SH
cat >"$kandelo_sdk_fake_bin/wasm32posix-cc" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
        output="$2"
        break
    fi
    shift
done
[ -n "$output" ] || exit 97
mkdir -p "$(dirname "$output")"
printf 'fake kandelo-sdk glue object\n' >"$output"
SH
cat >"$kandelo_sdk_repo/images/vfs/scripts/build-kandelo-sdk-vfs-image.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${KANDELO_SDK_GLUE_OBJ_DIR:?}" in
    "${WASM_POSIX_DEP_WORK_DIR:?}"/*) ;;
    *) exit 91 ;;
esac
case "${KANDELO_SDK_VFS_OUT:?}" in
    "${WASM_POSIX_DEP_OUT_DIR:?}"/*) ;;
    *) exit 92 ;;
esac
for name in channel_syscall compiler_rt cxxrt dlopen; do
    [ -f "$KANDELO_SDK_GLUE_OBJ_DIR/$name.o" ] || exit 93
done
mkdir -p "$(dirname "$KANDELO_SDK_VFS_OUT")"
printf 'fake kandelo-sdk VFS\n' >"$KANDELO_SDK_VFS_OUT"
SH
cat >"$kandelo_sdk_repo/scripts/install-local-binary.sh" <<'SH'
#!/usr/bin/env bash
install_local_binary() {
    : >"${KANDELO_UNEXPECTED_LOCAL_MIRROR:?}"
    return 97
}
SH
chmod 0755 "$kandelo_sdk_repo/sdk/activate.sh" \
    "$kandelo_sdk_fake_bin/wasm32posix-cc" \
    "$kandelo_sdk_repo/images/vfs/scripts/build-kandelo-sdk-vfs-image.sh" \
    "$kandelo_sdk_repo/scripts/install-local-binary.sh"
: >"$kandelo_sdk_seed/lib/libc.a"
printf 'kandelo-sdk shared seed\n' >"$kandelo_sdk_seed/include/seed.h"
: >"$kandelo_sdk_libcxx/lib/libc++.a"
: >"$kandelo_sdk_libcxx/lib/libc++abi.a"
: >"$kandelo_sdk_libcxx/lib/libc++-pic.a"
: >"$kandelo_sdk_libcxx/lib/libc++abi-pic.a"
printf 'kandelo-sdk libcxx header\n' >"$kandelo_sdk_libcxx/include/c++/v1/memory"
kandelo_sdk_before="$(tree_digest "$kandelo_sdk_seed")"
set +e
env \
    PATH="$kandelo_sdk_fake_bin:$PATH" \
    WASM_POSIX_DEP_NAME=kandelo-sdk \
    WASM_POSIX_DEP_WORK_DIR="$kandelo_sdk_work" \
    WASM_POSIX_DEP_OUT_DIR="$kandelo_sdk_out" \
    WASM_POSIX_DEP_LIBCXX_DIR="$kandelo_sdk_libcxx" \
    WASM_POSIX_SYSROOT="$kandelo_sdk_seed" \
    KANDELO_UNEXPECTED_LOCAL_MIRROR="$kandelo_sdk_fixture/local-mirror-called" \
    bash "$kandelo_sdk_recipe_dir/build-kandelo-sdk.sh" \
    >"$kandelo_sdk_fixture/stdout" 2>"$kandelo_sdk_fixture/stderr"
kandelo_sdk_status=$?
set -e
[ "$kandelo_sdk_status" -eq 0 ] ||
    fail "kandelo-sdk resolver fixture failed before publishing its VFS"
kandelo_sdk_after="$(tree_digest "$kandelo_sdk_seed")"
[ "$kandelo_sdk_after" = "$kandelo_sdk_before" ] ||
    fail "kandelo-sdk resolver build mutated its shared SDK sysroot"
kandelo_sdk_private_sysroot="$(find "$kandelo_sdk_work" -mindepth 1 -maxdepth 1 \
    -type d -name '.kandelo-kandelo-sdk-sysroot.*' -print -quit)"
[ -n "$kandelo_sdk_private_sysroot" ] ||
    fail "kandelo-sdk resolver build did not create a work-owned private sysroot"
[ -f "$kandelo_sdk_private_sysroot/lib/libc++.a" ] ||
    fail "kandelo-sdk private sysroot omitted the libcxx archive"
[ ! -e "$kandelo_sdk_private_sysroot/lib/libc++-pic.a" ] &&
    [ ! -e "$kandelo_sdk_private_sysroot/lib/libc++abi-pic.a" ] ||
    fail "kandelo-sdk private sysroot changed the VFS payload with PIC archives"
[ -f "$kandelo_sdk_work/kandelo-sdk-glue-objs/channel_syscall.o" ] &&
    [ -f "$kandelo_sdk_work/kandelo-sdk-glue-objs/compiler_rt.o" ] &&
    [ -f "$kandelo_sdk_work/kandelo-sdk-glue-objs/cxxrt.o" ] &&
    [ -f "$kandelo_sdk_work/kandelo-sdk-glue-objs/dlopen.o" ] ||
    fail "kandelo-sdk resolver build did not keep glue objects below its work root"
[ -f "$kandelo_sdk_out/kandelo-sdk.vfs.zst" ] ||
    fail "kandelo-sdk resolver build did not publish its declared VFS output"
[ "$(find "$kandelo_sdk_out" -type f | wc -l | tr -d ' ')" = 1 ] ||
    fail "kandelo-sdk resolver output contains undeclared files"
[ ! -e "$kandelo_sdk_recipe_dir/kandelo-sdk-glue-objs" ] &&
    [ ! -e "$kandelo_sdk_recipe_dir/kandelo-sdk.vfs.zst" ] ||
    fail "kandelo-sdk resolver build wrote checkout-local artifacts"
[ ! -e "$kandelo_sdk_fixture/local-mirror-called" ] ||
    fail "kandelo-sdk resolver build published a local mirror"

# PHP validates all of its declared dependency prefixes before projecting the
# C++ toolchain. Omit SourceOnly source authority so the fixture stops after
# the projection without entering the PHP compiler.
php_fixture="$TEST_ROOT/php-sysroot-race"
php_seed="$php_fixture/seed"
php_work="$php_fixture/work"
php_out="$php_fixture/out"
php_libcxx="$php_fixture/libcxx"
php_fake_bin="$php_fixture/fake-bin"
mkdir -p "$php_seed/lib" "$php_seed/include" "$php_work" "$php_out" \
    "$php_libcxx/lib" "$php_libcxx/include/c++/v1" "$php_fake_bin"
: >"$php_seed/lib/libc.a"
printf 'php shared seed\n' >"$php_seed/include/seed.h"
for lib in libc++.a libc++abi.a libc++-pic.a libc++abi-pic.a; do
    : >"$php_libcxx/lib/$lib"
done
printf 'php libcxx header\n' >"$php_libcxx/include/c++/v1/memory"
for dep in zlib sqlite openssl libxml2 libiconv libzip libcurl icu; do
    mkdir -p "$php_fixture/$dep/lib" "$php_fixture/$dep/include" \
        "$php_fixture/$dep/share"
done
: >"$php_fixture/zlib/lib/libz.a"
: >"$php_fixture/sqlite/lib/libsqlite3.a"
: >"$php_fixture/openssl/lib/libssl.a"
: >"$php_fixture/libxml2/lib/libxml2.a"
: >"$php_fixture/libiconv/lib/libiconv.a"
: >"$php_fixture/libzip/lib/libzip.a"
: >"$php_fixture/libcurl/lib/libcurl.a"
for lib in libicuuc.a libicui18n.a libicuio.a libicudata.a; do
    : >"$php_fixture/icu/lib/$lib"
done
: >"$php_fixture/icu/share/icu.dat"
cat >"$php_fake_bin/curl" <<'SH'
#!/usr/bin/env bash
: >"${KANDELO_UNEXPECTED_CURL:?}"
exit 97
SH
chmod 0755 "$php_fake_bin/curl"
php_before="$(tree_digest "$php_seed")"
set +e
env \
    PATH="$php_fake_bin:$PATH" \
    KANDELO_UNEXPECTED_CURL="$php_fixture/curl-was-called" \
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
    WASM_POSIX_DEP_NAME=php \
    WASM_POSIX_DEP_VERSION=8.3.15 \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_DEP_WORK_DIR="$php_work" \
    WASM_POSIX_DEP_OUT_DIR="$php_out" \
    WASM_POSIX_DEP_ZLIB_DIR="$php_fixture/zlib" \
    WASM_POSIX_DEP_SQLITE_DIR="$php_fixture/sqlite" \
    WASM_POSIX_DEP_OPENSSL_DIR="$php_fixture/openssl" \
    WASM_POSIX_DEP_LIBXML2_DIR="$php_fixture/libxml2" \
    WASM_POSIX_DEP_LIBICONV_DIR="$php_fixture/libiconv" \
    WASM_POSIX_DEP_LIBZIP_DIR="$php_fixture/libzip" \
    WASM_POSIX_DEP_LIBCURL_DIR="$php_fixture/libcurl" \
    WASM_POSIX_DEP_ICU_DIR="$php_fixture/icu" \
    WASM_POSIX_DEP_LIBCXX_DIR="$php_libcxx" \
    WASM_POSIX_SYSROOT="$php_seed" \
    WASM_POSIX_KEEP_BUILD_DIR=1 \
    bash "$REPO_ROOT/packages/registry/php/build-php.sh" \
    >"$php_fixture/stdout" 2>"$php_fixture/stderr"
php_status=$?
set -e
[ "$php_status" -ne 0 ] || fail "PHP source-boundary fixture unexpectedly succeeded"
php_after="$(tree_digest "$php_seed")"
[ "$php_after" = "$php_before" ] ||
    fail "PHP SourceOnly build mutated its shared SDK sysroot"
php_private_sysroot="$(find "$php_work" -mindepth 1 -maxdepth 1 \
    -type d -name '.kandelo-php-sysroot.*' -print -quit)"
[ -n "$php_private_sysroot" ] ||
    fail "PHP SourceOnly build did not create a work-owned private sysroot"
[ -f "$php_private_sysroot/lib/libc++.a" ] ||
    fail "PHP private sysroot omitted the libcxx archive"
[ -f "$php_private_sysroot/include/c++/v1/memory" ] ||
    fail "PHP private sysroot omitted the libcxx headers"

# run.sh invokes PHP directly when its local artifact is absent. That path must
# use the same private sysroot contract even though it has no resolver OUT root.
php_direct_repo="$php_fixture/direct-repo"
php_direct_seed="$php_fixture/direct-seed"
php_direct_tmp="$php_fixture/direct-tmp"
php_direct_tmp_link="$php_fixture/direct-tmp-link"
mkdir -p "$php_direct_repo/packages/registry/php" \
    "$php_direct_repo/scripts" "$php_direct_repo/sdk" \
    "$php_direct_seed/lib" "$php_direct_seed/include" "$php_direct_tmp"
ln -s "$php_direct_tmp" "$php_direct_tmp_link"
cp "$REPO_ROOT/packages/registry/php/build-php.sh" \
    "$php_direct_repo/packages/registry/php/build-php.sh"
cp "$REPO_ROOT/scripts/package-build-roots.sh" \
    "$php_direct_repo/scripts/package-build-roots.sh"
cat >"$php_direct_repo/sdk/activate.sh" <<'SH'
#!/usr/bin/env bash
:
SH
cat >"$php_fake_bin/wasm32posix-cc" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod 0755 "$php_fake_bin/wasm32posix-cc"
: >"$php_direct_seed/lib/libc.a"
printf 'php direct shared seed\n' >"$php_direct_seed/include/seed.h"
php_direct_before="$(tree_digest "$php_direct_seed")"
set +e
env \
    PATH="$php_fake_bin:$PATH" \
    TMPDIR="$php_direct_tmp_link" \
    KANDELO_UNEXPECTED_CURL="$php_fixture/direct-curl-was-called" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    WASM_POSIX_DEP_ZLIB_DIR="$php_fixture/zlib" \
    WASM_POSIX_DEP_SQLITE_DIR="$php_fixture/sqlite" \
    WASM_POSIX_DEP_OPENSSL_DIR="$php_fixture/openssl" \
    WASM_POSIX_DEP_LIBXML2_DIR="$php_fixture/libxml2" \
    WASM_POSIX_DEP_LIBICONV_DIR="$php_fixture/libiconv" \
    WASM_POSIX_DEP_LIBZIP_DIR="$php_fixture/libzip" \
    WASM_POSIX_DEP_LIBCURL_DIR="$php_fixture/libcurl" \
    WASM_POSIX_DEP_ICU_DIR="$php_fixture/icu" \
    WASM_POSIX_DEP_LIBCXX_DIR="$php_libcxx" \
    WASM_POSIX_SYSROOT="$php_direct_seed" \
    bash "$php_direct_repo/packages/registry/php/build-php.sh" \
    >"$php_fixture/direct-stdout" 2>"$php_fixture/direct-stderr"
php_direct_status=$?
set -e
[ "$php_direct_status" -ne 0 ] ||
    fail "PHP direct fixture unexpectedly passed its controlled source boundary"
[ -f "$php_fixture/direct-curl-was-called" ] ||
    fail "PHP direct fixture did not exercise the ordinary run.sh path"
php_direct_after="$(tree_digest "$php_direct_seed")"
[ "$php_direct_after" = "$php_direct_before" ] ||
    fail "PHP direct build mutated its shared SDK sysroot"

echo "test-package-isolated-output-contracts: PASS"
