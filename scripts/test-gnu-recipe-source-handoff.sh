#!/usr/bin/env bash
# Cached, resolver-verified GNU sources must reach configure without network
# access or writes to the source tree. Stop at configure to isolate acquisition.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
test_root="$(mktemp -d)"
test_root="$(cd "$test_root" && pwd -P)"
trap 'chmod -R u+w "$test_root"; rm -rf "$test_root"' EXIT

fail() {
    echo "test-gnu-recipe-source-handoff.sh: $*" >&2
    exit 1
}

mkdir -p "$test_root/bin" "$test_root/source" \
    "$test_root/openssl/lib" "$test_root/zlib/lib"
: > "$test_root/openssl/lib/libssl.a"
: > "$test_root/openssl/lib/libcrypto.a"
: > "$test_root/zlib/lib/libz.a"
printf 'verified source sentinel\n' > "$test_root/source/source-marker"
printf 'resolver archive evidence\n' > "$test_root/source.archive"
cat > "$test_root/bin/curl" <<'CURL'
#!/usr/bin/env bash
touch "$GNU_RECIPE_NETWORK_SENTINEL"
exit 99
CURL
cat > "$test_root/source/configure" <<'CONFIGURE'
#!/usr/bin/env bash
set -euo pipefail
test "$(cat source-marker)" = 'verified source sentinel'
test -w source-marker
pwd -P > "$GNU_RECIPE_CONFIGURE_SENTINEL"
exit 89
CONFIGURE
chmod +x "$test_root/bin/curl" "$test_root/source/configure"
chmod -R a-w "$test_root/source"

for package in libiconv gzip wget; do
    mkdir -p "$test_root/$package-work" "$test_root/$package-out"
    recipe_status=0
    # activate.sh leaves an already-present SDK path in place, so curl stays
    # a deliberately unavailable network transport in these recipes.
    PATH="$test_root/bin:$REPO_ROOT/sdk/bin:$PATH" \
        WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
        WASM_POSIX_DEP_SOURCE_ARCHIVE="$test_root/source.archive" \
        WASM_POSIX_DEP_SOURCE_DIR="$test_root/source" \
        WASM_POSIX_DEP_WORK_DIR="$test_root/$package-work" \
        WASM_POSIX_DEP_OUT_DIR="$test_root/$package-out" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        WASM_POSIX_DEP_OPENSSL_DIR="$test_root/openssl" \
        WASM_POSIX_DEP_ZLIB_DIR="$test_root/zlib" \
        GNU_RECIPE_NETWORK_SENTINEL="$test_root/$package-network" \
        GNU_RECIPE_CONFIGURE_SENTINEL="$test_root/$package-configure" \
        bash "$REPO_ROOT/packages/registry/$package/build-$package.sh" \
        > "$test_root/$package.log" 2>&1 || recipe_status=$?
    if [ "$recipe_status" != 89 ]; then
        cat "$test_root/$package.log" >&2
        fail "$package did not reach configure with resolver-supplied source (exit $recipe_status)"
    fi
    [ ! -e "$test_root/$package-network" ] || fail "$package attempted a second download"
    case "$(cat "$test_root/$package-configure")" in
        "$test_root/$package-work/"*) ;;
        *) fail "$package configured outside the caller's work root" ;;
    esac
    [ -z "$(find "$test_root/source" -perm -u=w -print -quit)" ] ||
        fail "$package made the resolver source writable"
    [ "$(cat "$test_root/source/source-marker")" = 'verified source sentinel' ] ||
        fail "$package changed the resolver source"
done

echo "test-gnu-recipe-source-handoff.sh: ok"
