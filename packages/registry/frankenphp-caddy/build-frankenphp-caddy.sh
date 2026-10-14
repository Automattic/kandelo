#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
source "$REPO_ROOT/sdk/activate.sh"

: "${WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR:?pinned Go source is required}"
: "${WASM_POSIX_BUILD_GIT_XSYS_DIR:?pinned x/sys source is required}"
: "${WASM_POSIX_BUILD_GIT_BBOLT_DIR:?pinned bbolt source is required}"
: "${WASM_POSIX_BUILD_GIT_READLINE_DIR:?pinned readline source is required}"
: "${WASM_POSIX_BUILD_GIT_LOGRUS_DIR:?pinned logrus source is required}"
: "${WASM_POSIX_BUILD_GIT_CERTIFICATE_TRANSPARENCY_DIR:?pinned certificate-transparency source is required}"
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
mkdir -p "$GO_ROOT" "$WORK_DIR/tmp" "$WORK_DIR/gocache" "$WORK_DIR/gopath" "$WORK_DIR/gomodcache"

tar --exclude=.git -cf - -C "$WASM_POSIX_BUILD_GIT_GO_TOOLCHAIN_DIR" . |
    tar -xf - -C "$GO_ROOT"
chmod -R u+w "$GO_ROOT"
export GOROOT_BOOTSTRAP="$(go env GOROOT)"
(cd "$GO_ROOT/src" && ./make.bash)

kandelo_package_stage_verified_source frankenphp-caddy "$SOURCE_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK_DIR"
(cd "$SOURCE_DIR" && git apply "$REPO_ROOT/packages/registry/frankenphp-classic/frankenphp-kandelo.patch")
mkdir -p "$SOURCE_DIR/caddy/cmd/kandelo" "$SOURCE_DIR/lib"
cp "$SCRIPT_DIR/main.go" "$SOURCE_DIR/caddy/cmd/kandelo/main.go"

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

stage_go_module() {
    local name="$1" source="$2" module="$3"
    local destination="$WORK_DIR/$name"
    mkdir -p "$destination"
    tar --exclude=.git -cf - -C "$source" . |
        tar -xf - -C "$destination"
    chmod -R u+w "$destination"
    (cd "$SOURCE_DIR/caddy" && "$GO_ROOT/bin/go" mod edit -replace="$module=../../$name")
}

export GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=
export GOCACHE="$WORK_DIR/gocache" GOPATH="$WORK_DIR/gopath"
export GOMODCACHE="$WORK_DIR/gomodcache" GOTMPDIR="$WORK_DIR/tmp"
export GOROOT="$GO_ROOT" GOOS=kandelo GOARCH=wasm CGO_ENABLED=1 CC=wasm32posix-cc
php_include="$WASM_POSIX_DEP_PHP_ZTS_DIR/include/php"
export CGO_CFLAGS="-I$php_include -I$php_include/main -I$php_include/Zend -I$php_include/TSRM -I$php_include/sapi/embed -I$php_include/ext"

stage_go_module xsys "$WASM_POSIX_BUILD_GIT_XSYS_DIR" golang.org/x/sys
stage_go_module bbolt "$WASM_POSIX_BUILD_GIT_BBOLT_DIR" go.etcd.io/bbolt
stage_go_module readline "$WASM_POSIX_BUILD_GIT_READLINE_DIR" github.com/chzyer/readline
stage_go_module logrus "$WASM_POSIX_BUILD_GIT_LOGRUS_DIR" github.com/sirupsen/logrus
stage_go_module certificate-transparency "$WASM_POSIX_BUILD_GIT_CERTIFICATE_TRANSPARENCY_DIR" github.com/google/certificate-transparency-go

(cd "$SOURCE_DIR/caddy" && "$GO_ROOT/bin/go" build -tags nowatcher \
    -o "$WORK_DIR/frankenphp-caddy.wasm" ./cmd/kandelo)
unset CC CXX AR RANLIB CFLAGS CXXFLAGS CPPFLAGS LDFLAGS
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$WORK_DIR/frankenphp-caddy.wasm" \
    -o "$WORK_DIR/frankenphp-caddy-instrumented.wasm"
if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" != source-only-v1 ]; then
    source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
    record_built_program_output "$WORK_DIR/frankenphp-caddy-instrumented.wasm"
    stamp_built_program_outputs
fi

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary frankenphp-caddy "$WORK_DIR/frankenphp-caddy-instrumented.wasm" frankenphp-caddy.wasm
