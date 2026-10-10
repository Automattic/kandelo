#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
source "$REPO_ROOT/sdk/activate.sh"

: "${WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR:?pinned Go source is required}"
: "${WASM_POSIX_DEP_PHP_ZTS_DIR:?php-zts dependency is required}"
: "${WASM_POSIX_DEP_ICU_DIR:?ICU dependency is required}"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?libcxx dependency is required}"
: "${WASM_POSIX_DEP_LIBCURL_DIR:?curl dependency is required}"
: "${WASM_POSIX_DEP_LIBZIP_DIR:?zip dependency is required}"
: "${WASM_POSIX_DEP_LIBXML2_DIR:?libxml2 dependency is required}"
: "${WASM_POSIX_DEP_OPENSSL_DIR:?OpenSSL dependency is required}"
: "${WASM_POSIX_DEP_SQLITE_DIR:?SQLite dependency is required}"
: "${WASM_POSIX_DEP_LIBICONV_DIR:?iconv dependency is required}"
: "${WASM_POSIX_DEP_ZLIB_DIR:?zlib dependency is required}"

WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
GO_ROOT="$WORK_DIR/go"
SOURCE_DIR="$WORK_DIR/frankenphp-src"
MODULE_DIR="$WORK_DIR/xsys-kandelo"
mkdir -p "$GO_ROOT" "$WORK_DIR/tmp" "$WORK_DIR/gocache" "$WORK_DIR/gopath" "$WORK_DIR/gomodcache"

tar --exclude=.git -cf - -C "$WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR" . |
    tar -xf - -C "$GO_ROOT"
chmod -R u+w "$GO_ROOT"
export GOROOT_BOOTSTRAP="$(go env GOROOT)"
(cd "$GO_ROOT/src" && ./make.bash)

kandelo_package_stage_verified_source frankenphp-classic "$SOURCE_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK_DIR"
(cd "$SOURCE_DIR" && git apply "$SCRIPT_DIR/frankenphp-kandelo.patch")
mkdir -p "$SOURCE_DIR/cmd/kandelo-classic" "$SOURCE_DIR/lib"
cp "$SCRIPT_DIR/main.go" "$SOURCE_DIR/cmd/kandelo-classic/main.go"

link_archive() {
    local prefix="$1" archive="$2"
    test -f "$prefix/lib/$archive"
    ln -s "$prefix/lib/$archive" "$SOURCE_DIR/lib/$archive"
}
link_archive "$WASM_POSIX_DEP_PHP_ZTS_DIR" libphp.a
for archive in libicui18n.a libicuio.a libicuuc.a libicudata.a; do
    link_archive "$WASM_POSIX_DEP_ICU_DIR" "$archive"
done
link_archive "$WASM_POSIX_DEP_LIBCXX_DIR" libc++.a
link_archive "$WASM_POSIX_DEP_LIBCXX_DIR" libc++abi.a
link_archive "$WASM_POSIX_DEP_LIBCURL_DIR" libcurl.a
link_archive "$WASM_POSIX_DEP_LIBZIP_DIR" libzip.a
link_archive "$WASM_POSIX_DEP_LIBXML2_DIR" libxml2.a
link_archive "$WASM_POSIX_DEP_OPENSSL_DIR" libssl.a
link_archive "$WASM_POSIX_DEP_OPENSSL_DIR" libcrypto.a
link_archive "$WASM_POSIX_DEP_SQLITE_DIR" libsqlite3.a
link_archive "$WASM_POSIX_DEP_LIBICONV_DIR" libiconv.a
link_archive "$WASM_POSIX_DEP_ZLIB_DIR" libz.a
link_archive "$REPO_ROOT/sysroot" libkandelo-ucontext-unsupported.a

export GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=
export GOCACHE="$WORK_DIR/gocache" GOPATH="$WORK_DIR/gopath"
export GOMODCACHE="$WORK_DIR/gomodcache" GOTMPDIR="$WORK_DIR/tmp"
export GOROOT="$GO_ROOT" GOOS=kandelo GOARCH=wasm CGO_ENABLED=1 CC=wasm32posix-cc
php_include="$WASM_POSIX_DEP_PHP_ZTS_DIR/include/php"
export CGO_CFLAGS="-I$php_include -I$php_include/main -I$php_include/Zend -I$php_include/TSRM -I$php_include/sapi/embed -I$php_include/ext"

(cd "$SOURCE_DIR" && "$GO_ROOT/bin/go" mod download golang.org/x/sys@v0.39.0)
cp -R "$GOMODCACHE/golang.org/x/sys@v0.39.0" "$MODULE_DIR"
chmod -R u+w "$MODULE_DIR"
(cd "$MODULE_DIR" && git apply "$SCRIPT_DIR/xsys-kandelo.patch")
(cd "$SOURCE_DIR" && "$GO_ROOT/bin/go" mod edit -replace=golang.org/x/sys=../xsys-kandelo)
(cd "$SOURCE_DIR" && "$GO_ROOT/bin/go" build -tags 'nomercure nowatcher' \
    -o "$WORK_DIR/frankenphp-classic.wasm" ./cmd/kandelo-classic)
unset CC CXX AR RANLIB CFLAGS CXXFLAGS CPPFLAGS LDFLAGS
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$WORK_DIR/frankenphp-classic.wasm" \
    -o "$WORK_DIR/frankenphp-classic-instrumented.wasm"
source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
record_built_program_output "$WORK_DIR/frankenphp-classic-instrumented.wasm"
stamp_built_program_outputs

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary frankenphp-classic "$WORK_DIR/frankenphp-classic-instrumented.wasm" frankenphp-classic.wasm
