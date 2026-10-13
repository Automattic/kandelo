#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
source_dir="$repo_root/tests/go/cgo/php-embed"
output_dir="$repo_root/.context/go-php-embed"
fixture_dir="$output_dir/fixture"
mkdir -p "$fixture_dir/lib"
cp "$source_dir/main.go" "$fixture_dir/main.go"

source "$repo_root/sdk/activate.sh"
resolve_dep() {
    (cd "$repo_root" && cargo xtask build-deps --arch wasm32 resolve "$1")
}
link_archives() {
    local prefix
    prefix="$(resolve_dep "$1")"
    shift
    local archive
    for archive in "$@"; do
        test -f "$prefix/lib/$archive"
        ln -sf "$prefix/lib/$archive" "$fixture_dir/lib/$archive"
    done
}

php_prefix="$(resolve_dep php-zts)"
test -f "$php_prefix/lib/libphp.a"
ln -sf "$php_prefix/lib/libphp.a" "$fixture_dir/lib/libphp.a"
link_archives icu libicui18n.a libicuio.a libicuuc.a libicudata.a
link_archives libcxx 'libc++.a' 'libc++abi.a'
link_archives libcurl libcurl.a
link_archives libzip libzip.a
link_archives libxml2 libxml2.a
link_archives openssl libssl.a libcrypto.a
link_archives sqlite libsqlite3.a
link_archives libiconv libiconv.a
link_archives zlib libz.a
ln -sf "$repo_root/sysroot/lib/libkandelo-ucontext-unsupported.a" \
    "$fixture_dir/lib/libkandelo-ucontext-unsupported.a"

php_include="$php_prefix/include/php"
export CGO_CFLAGS="-I$php_include -I$php_include/main -I$php_include/Zend -I$php_include/TSRM -I$php_include/sapi/embed -I$php_include/ext"
GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc \
    "$repo_root/../go-kandelo/bin/go" build -a -o "$output_dir/probe.wasm" "$fixture_dir/main.go"
wasm-validate --enable-threads --enable-exceptions "$output_dir/probe.wasm"
"$repo_root/scripts/run-wasm-fork-instrument.sh" "$output_dir/probe.wasm" \
    -o "$output_dir/probe-instrumented.wasm"
REPO_ROOT="$repo_root" bash -c '
    source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
    record_built_program_output "$REPO_ROOT/.context/go-php-embed/probe-instrumented.wasm"
    stamp_built_program_outputs
'
