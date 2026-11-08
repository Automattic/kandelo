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

source "$REPO_ROOT/scripts/build-kandelo-go-toolchain.sh"
kandelo_build_go_toolchain "$WORK_DIR"
GO_ROOT="$KANDELO_BUILT_GO_ROOT"

kandelo_package_stage_verified_source frankenphp-classic "$SOURCE_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK_DIR"
mkdir -p "$SOURCE_DIR/cmd/kandelo-classic"
cp "$SCRIPT_DIR/main.go" "$SOURCE_DIR/cmd/kandelo-classic/main.go"

source "$REPO_ROOT/scripts/go-cgo-static-libs.sh"
kandelo_go_require_static_archives "$WASM_POSIX_DEP_PHP_ZTS_DIR" libphp.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_ICU_DIR" \
    libicui18n.a libicuio.a libicuuc.a libicudata.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_LIBCXX_DIR" libc++.a libc++abi.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_LIBCURL_DIR" libcurl.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_LIBZIP_DIR" libzip.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_LIBXML2_DIR" libxml2.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_OPENSSL_DIR" libssl.a libcrypto.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_SQLITE_DIR" libsqlite3.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_LIBICONV_DIR" libiconv.a
kandelo_go_require_static_archives "$WASM_POSIX_DEP_ZLIB_DIR" libz.a
# SDK compatibility archives use the linker's normal compiler lookup.
test -f "$REPO_ROOT/sysroot/lib/libkandelo-ucontext-unsupported.a"

export GOENV=off GOTOOLCHAIN=local GOWORK=off
export GOMAXPROCS="${GOMAXPROCS:-4}" GOFLAGS="-trimpath -p=${GOMAXPROCS:-4}"
export GOCACHE="$WORK_DIR/gocache" GOPATH="$WORK_DIR/gopath"
export GOMODCACHE="$WORK_DIR/gomodcache" GOTMPDIR="$WORK_DIR/tmp"
export GOROOT="$GO_ROOT" GOOS=kandelo GOARCH=wasm32 CGO_ENABLED=1 CC=wasm32posix-cc
php_include="$WASM_POSIX_DEP_PHP_ZTS_DIR/include/php"
# CGO_CFLAGS replaces Go's defaults; retain optimization when adding PHP headers.
export CGO_CFLAGS="-O2 -I$php_include -I$php_include/main -I$php_include/Zend -I$php_include/TSRM -I$php_include/sapi/embed -I$php_include/ext"
# Upstream documents CGO_LDFLAGS for PHP linkage. Supply the declared static
# closure here; keep its Go/C sources and bulk CGI registration unchanged.
export CGO_LDFLAGS="${KANDELO_GO_STATIC_LIBRARY_FLAGS[*]} -lphp -licui18n -licuio -licuuc -licudata -lc++ -lc++abi -lcurl -lzip -lxml2 -lssl -lcrypto -lsqlite3 -liconv -lz -lkandelo-ucontext-unsupported -ldl"
mkdir -p "$MODULE_DIR"
tar --exclude=.git -cf - -C "$WASM_POSIX_BUILD_GIT_XSYS_DIR" . |
    tar -xf - -C "$MODULE_DIR"
chmod -R u+w "$MODULE_DIR"
(cd "$SOURCE_DIR" && "$GO_ROOT/bin/go" mod edit -replace=golang.org/x/sys=../xsys-kandelo)
(cd "$SOURCE_DIR" && "$GO_ROOT/bin/go" build -tags 'nomercure nowatcher' \
    -o "$WORK_DIR/frankenphp-classic.wasm" ./cmd/kandelo-classic)
unset CC CXX AR RANLIB CFLAGS CXXFLAGS CPPFLAGS LDFLAGS
echo "frankenphp-classic linked bytes before instrumentation: $(wc -c < "$WORK_DIR/frankenphp-classic.wasm")"
"$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$WORK_DIR/frankenphp-classic.wasm" \
    -o "$WORK_DIR/frankenphp-classic-instrumented.wasm"
echo "frankenphp-classic bytes after instrumentation and post-optimization: $(wc -c < "$WORK_DIR/frankenphp-classic-instrumented.wasm")"
if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" != source-only-v1 ]; then
    source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
    record_built_program_output "$WORK_DIR/frankenphp-classic-instrumented.wasm"
    stamp_built_program_outputs
fi

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary frankenphp-classic "$WORK_DIR/frankenphp-classic-instrumented.wasm" frankenphp-classic.wasm
