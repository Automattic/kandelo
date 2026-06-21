#!/usr/bin/env bash
#
# Verify that the libcxx package version matches the exact LLVM version
# exported by flake.nix. This is intentionally scoped to the repo package
# build environment; normal SDK consumers do not need to run it.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ -z "${LLVM_VERSION:-}" ]; then
    echo "ERROR: LLVM_VERSION is not set." >&2
    echo "       Run through scripts/dev-shell.sh so flake.nix declares the LLVM version." >&2
    exit 1
fi

if [ -z "${LLVM_PREFIX:-}" ] || [ ! -x "$LLVM_PREFIX/bin/clang" ]; then
    echo "ERROR: LLVM_PREFIX does not point at a clang toolchain." >&2
    echo "       LLVM_PREFIX=${LLVM_PREFIX:-<unset>}" >&2
    echo "       Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if [ -z "${WASM_POSIX_LLVM_LIBCXX_SOURCE:-}" ] ||
        [ ! -f "$WASM_POSIX_LLVM_LIBCXX_SOURCE/runtimes/CMakeLists.txt" ] ||
        [ ! -d "$WASM_POSIX_LLVM_LIBCXX_SOURCE/libcxx" ] ||
        [ ! -d "$WASM_POSIX_LLVM_LIBCXX_SOURCE/libcxxabi" ]; then
    echo "ERROR: WASM_POSIX_LLVM_LIBCXX_SOURCE is missing or incomplete." >&2
    echo "       WASM_POSIX_LLVM_LIBCXX_SOURCE=${WASM_POSIX_LLVM_LIBCXX_SOURCE:-<unset>}" >&2
    echo "       Run through scripts/dev-shell.sh." >&2
    exit 1
fi

if [ -z "${WASM_POSIX_LLVM_LIBUNWIND_SOURCE:-}" ] ||
        [ ! -d "$WASM_POSIX_LLVM_LIBUNWIND_SOURCE/libunwind" ]; then
    echo "ERROR: WASM_POSIX_LLVM_LIBUNWIND_SOURCE is missing or incomplete." >&2
    echo "       WASM_POSIX_LLVM_LIBUNWIND_SOURCE=${WASM_POSIX_LLVM_LIBUNWIND_SOURCE:-<unset>}" >&2
    echo "       Run through scripts/dev-shell.sh." >&2
    exit 1
fi

LIBCXX_VERSION="$(
    awk -F '"' '/^version[[:space:]]*=/ { print $2; exit }' \
        packages/registry/libcxx/package.toml
)"

if [ -z "$LIBCXX_VERSION" ]; then
    echo "ERROR: could not read version from packages/registry/libcxx/package.toml." >&2
    exit 1
fi

if [ "$LIBCXX_VERSION" != "$LLVM_VERSION" ]; then
    echo "ERROR: libcxx package version ($LIBCXX_VERSION) does not match flake LLVM_VERSION ($LLVM_VERSION)." >&2
    echo "       Update packages/registry/libcxx/package.toml and libcxx dependents with the exact Nix LLVM version." >&2
    exit 1
fi

CLANG_VERSION="$(
    "$LLVM_PREFIX/bin/clang" --version |
        awk 'match($0, /[0-9]+\.[0-9]+\.[0-9]+/) { print substr($0, RSTART, RLENGTH); exit }'
)"
if [ "$CLANG_VERSION" != "$LLVM_VERSION" ]; then
    echo "ERROR: clang version ($CLANG_VERSION) does not match flake LLVM_VERSION ($LLVM_VERSION)." >&2
    echo "       LLVM_PREFIX=$LLVM_PREFIX" >&2
    exit 1
fi

BAD_DEPS="$(
    find packages/registry -name package.toml -print0 |
        xargs -0 grep -H 'libcxx@' |
        grep -v "libcxx@$LIBCXX_VERSION" || true
)"
if [ -n "$BAD_DEPS" ]; then
    echo "ERROR: package manifests reference a different libcxx version than $LIBCXX_VERSION:" >&2
    echo "$BAD_DEPS" >&2
    exit 1
fi

echo "libcxx: package version, flake LLVM_VERSION, clang, and package dependencies all match $LLVM_VERSION."
