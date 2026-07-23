#!/usr/bin/env bash
#
# Resolve one repository artifact through the same TypeScript resolver used by
# Node and browser build tooling. The Rust-generated program package projection
# therefore governs shell, TypeScript, external registries, and installed host
# packages without a second manifest parser.
#
# Usage:
#   scripts/resolve-binary.sh kernel.wasm
#   scripts/resolve-binary.sh programs/dash.wasm
#   scripts/resolve-binary.sh programs/cpython/python.wasm

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
if [ $# -ne 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    sed -n '3,12p' "$0"
    exit 0
fi

repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

# Source checkouts verify their generated program-package projection with the
# exact Rust manifest/cache-key implementation before Node consumes it. Prepare
# the release xtask once and pass its path into the bundled resolver; installed
# host packages and deliberately minimal resolver fixtures have no xtask source
# tree and continue to use their pack-time-verified bundled projection.
checker_root="${WASM_POSIX_BINARY_RESOLVER_REPO_ROOT:-$repo_root}"
if [[ "$1" == programs/* ]] &&
    [ -z "${WASM_POSIX_XTASK_BIN:-}" ] &&
    [ -f "$checker_root/tools/xtask/Cargo.toml" ] &&
    [ -f "$checker_root/scripts/dev-shell.sh" ]; then
    if [ -n "${KANDELO_DEV_SHELL_TOOL_PATH:-}" ]; then
        host_target="$(rustc -vV | awk '/^host:/ {print $2}')"
    else
        host_target="$(
            bash "$checker_root/scripts/dev-shell.sh" rustc -vV |
                awk '/^host:/ {print $2}'
        )"
    fi
    if [ -z "$host_target" ]; then
        echo "resolve-binary: could not determine the Rust host target" >&2
        exit 1
    fi
    WASM_POSIX_XTASK_BIN="$checker_root/target/$host_target/release/xtask"
    # An existing path may belong to an older source state. Cargo's
    # incremental no-op is the exact preparation check for this invocation.
    if [ -n "${KANDELO_DEV_SHELL_TOOL_PATH:-}" ]; then
        (
            cd "$checker_root"
            cargo build --release -p xtask --target "$host_target" --quiet
        )
    else
        (
            cd "$checker_root"
            bash scripts/dev-shell.sh \
                cargo build --release -p xtask --target "$host_target" --quiet
        ) >&2
    fi
    export WASM_POSIX_XTASK_BIN
fi

exec node "$script_dir/resolve-binary.bundle.mjs" "$1"
