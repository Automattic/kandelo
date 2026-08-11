#!/usr/bin/env bash

# Bind commands that consume a transported CI test workspace to the exact
# package cache and checker shipped beside its binaries/ mirror. This file may
# be sourced by a larger suite runner or executed as a command wrapper.
activate_ci_test_workspace() {
    local script_dir
    local repo_root
    local portable_cache
    local rust_host
    local prepared_xtask

    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    repo_root="$(cd "$script_dir/.." && pwd)"
    portable_cache="$repo_root/.ci-test-binary-cache"
    if [ ! -d "$portable_cache/programs" ]; then
        return 0
    fi

    rust_host="$(rustc -vV | awk '/^host:/ {print $2}')"
    if [ -z "$rust_host" ]; then
        echo "activate-ci-test-workspace: rustc did not report a host target" >&2
        return 1
    fi
    prepared_xtask="$repo_root/target/$rust_host/release/xtask"
    if [ ! -f "$prepared_xtask" ] || [ ! -x "$prepared_xtask" ]; then
        echo "activate-ci-test-workspace: missing executable prepared package checker: $prepared_xtask" >&2
        return 1
    fi

    # The portable binaries/ links name generations below this cache. Both
    # resolvers must see the same cache root and the pack-time checker before
    # they are allowed to consume any member of that mirror.
    export WASM_POSIX_BINARY_CACHE_ROOT="$portable_cache"
    export WASM_POSIX_XTASK_BIN="$prepared_xtask"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -euo pipefail
    if [ "$#" -eq 0 ]; then
        echo "usage: $0 <command> [args...]" >&2
        exit 2
    fi
    activate_ci_test_workspace
    exec "$@"
fi
