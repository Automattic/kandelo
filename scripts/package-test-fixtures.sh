#!/usr/bin/env bash
# Contract-aware fixture builders; source from shell automation tests.

package_test_copy_recipe() {
    local authority="$1" fixture_repo="$2" package="$3"
    mkdir -p "$fixture_repo/packages/registry/$package" \
        "$fixture_repo/scripts" "$fixture_repo/sdk"
    cp "$authority/packages/registry/$package/package.toml" \
        "$fixture_repo/packages/registry/$package/"
    cp "$authority/packages/registry/$package/build-$package.sh" \
        "$fixture_repo/packages/registry/$package/"
    cp "$authority/scripts/package-build-roots.sh" \
        "$authority/scripts/package-source-metadata.py" "$fixture_repo/scripts/"
    cp "$authority/sdk/activate.sh" "$fixture_repo/sdk/"
}

package_test_write_program() {
    local authority="$1" output="$2" marker="${3:-fixture_marker}" abi
    [[ "$marker" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || return 2
    source "$authority/scripts/wasm-artifact-guards.sh"
    abi="$(wasm_current_abi_version "$authority")" || return
    [[ "$abi" =~ ^[0-9]+$ ]] || return 2
    printf '(module (func (export "__abi_version") (result i32) i32.const %s) (func (export "_start")) (global (export "%s") i32 (i32.const 1)))\n' \
        "$abi" "$marker" | wat2wasm -o "$output" -
}

package_test_verified_source() {
    local source="$1" archive="$2"
    mkdir -p "$source"
    printf 'fixture archive evidence\n' > "$archive"
    export WASM_POSIX_DEP_SOURCE_DIR="$source"
    export WASM_POSIX_DEP_SOURCE_ARCHIVE="$archive"
}
