#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
    echo "test-curl-legacy-build-dependencies: $*" >&2
    exit 1
}

fixture_repo="$TEST_ROOT/repo"
mkdir -p \
    "$fixture_repo/scripts" \
    "$fixture_repo/sdk" \
    "$fixture_repo/sysroot/lib" "$fixture_repo/sysroot/include" \
    "$fixture_repo/packages/registry/zlib" \
    "$fixture_repo/packages/registry/openssl" \
    "$fixture_repo/packages/registry/libcurl"

# Execute the real target functions against a disposable package tree. The
# fixture replaces only the top-level dispatcher so it can call curl-cli alone.
awk '
    /^# ─── Main dispatch/ {
        print "source \"${KANDELO_CURL_BUILD_TEST_HOOK:?}\""
        exit
    }
    { print }
' "$REPO_ROOT/run.sh" >"$fixture_repo/run.sh"
chmod 0755 "$fixture_repo/run.sh"

for helper in browser-memory64-example-fixtures.sh wasm-artifact-guards.sh; do
    printf ':\n' >"$fixture_repo/scripts/$helper"
done
printf ':\n' >"$fixture_repo/sdk/activate.sh"

cat >"$fixture_repo/packages/registry/zlib/build-zlib.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$root/packages/registry/zlib/zlib-install/include" \
    "$root/packages/registry/zlib/zlib-install/lib/pkgconfig"
: >"$root/packages/registry/zlib/zlib-install/include/zlib.h"
: >"$root/packages/registry/zlib/zlib-install/include/zconf.h"
: >"$root/packages/registry/zlib/zlib-install/lib/libz.a"
printf 'prefix=/usr\n' >"$root/packages/registry/zlib/zlib-install/lib/pkgconfig/zlib.pc"
SH
cat >"$fixture_repo/packages/registry/openssl/build-openssl.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$root/packages/registry/openssl/openssl-install/include/openssl" \
    "$root/packages/registry/openssl/openssl-install/lib/pkgconfig"
: >"$root/packages/registry/openssl/openssl-install/lib/libssl.a"
: >"$root/packages/registry/openssl/openssl-install/lib/libcrypto.a"
SH
cat >"$fixture_repo/packages/registry/libcurl/build-libcurl.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
[ -f "$root/sysroot/lib/libz.a" ] || exit 81
[ -f "$root/sysroot/lib/libssl.a" ] || exit 82
[ -f "$root/sysroot/lib/libcrypto.a" ] || exit 83
mkdir -p "$root/packages/registry/curl/bin"
printf 'curl fixture\n' >"$root/packages/registry/curl/bin/curl.wasm"
SH
chmod 0755 \
    "$fixture_repo/packages/registry/zlib/build-zlib.sh" \
    "$fixture_repo/packages/registry/openssl/build-openssl.sh" \
    "$fixture_repo/packages/registry/libcurl/build-libcurl.sh"

hook="$TEST_ROOT/run-hook.sh"
cat >"$hook" <<'SH'
has_curl() { return 1; }
need_kernel() { :; }
need_sdk() { :; }
build_curl_cli
SH

if ! KANDELO_CURL_BUILD_TEST_HOOK="$hook" bash "$fixture_repo/run.sh"; then
    fail "ordinary curl-cli build did not materialize its legacy dependencies"
fi

[ -f "$fixture_repo/sysroot/lib/libz.a" ] ||
    fail "ordinary curl-cli build did not install zlib into the sysroot"
[ -f "$fixture_repo/sysroot/lib/libssl.a" ] &&
    [ -f "$fixture_repo/sysroot/lib/libcrypto.a" ] ||
    fail "ordinary curl-cli build did not install OpenSSL into the sysroot"
[ -f "$fixture_repo/packages/registry/curl/bin/curl.wasm" ] ||
    fail "ordinary curl-cli build did not run after its sysroot dependencies"

echo "test-curl-legacy-build-dependencies: PASS"
