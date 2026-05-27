#!/usr/bin/env bash
#
# Resolve a binary relative to the binaries/ tree. Priority:
#   1. $REPO/local-binaries/<rel>   (user override unless it is a legacy
#                                    fork artifact and fetched release is fresh)
#   2. $REPO/binaries/<rel>         (fetched release)
#
# Prints the absolute path on stdout, or prints a helpful error to
# stderr and exits 1.
#
# This is the shell-script equivalent of host/src/binary-resolver.ts.
# Keep them in sync.
#
# Usage:
#   $(scripts/resolve-binary.sh kernel.wasm)
#   $(scripts/resolve-binary.sh programs/dash.wasm)
#   $(scripts/resolve-binary.sh vfs/shell.vfs.zst)

set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/wasm-artifact-guards.sh"

if [ $# -ne 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    sed -n '3,18p' "$0"
    exit 0
fi

rel="$1"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
    # Fall back to walking up from $PWD looking for the workspace
    # Cargo.toml + abi/snapshot.json (a unique pair only present at
    # this repo's root).
    dir="$(pwd)"
    while [ "$dir" != "/" ]; do
        if [ -f "$dir/Cargo.toml" ] && [ -f "$dir/abi/snapshot.json" ]; then
            repo_root="$dir"
            break
        fi
        dir="$(dirname "$dir")"
    done
fi
if [ -z "$repo_root" ]; then
    echo "ERROR: could not find repo root" >&2
    exit 1
fi

# Default-arch shim: callers historically pass `programs/<x>` without
# an arch segment (run.sh has 30+ `has_resolvable programs/<name>.wasm`
# checks). After the per-arch layout refactor, those files live at
# `programs/wasm32/<x>` (or `wasm64/<x>`). Inject `wasm32/` when the
# caller's path starts with `programs/` and the next segment isn't
# already `wasm32` or `wasm64`. Mirrors the same shim in
# host/src/binary-resolver.ts (applyDefaultArch).
adjusted="$rel"
case "$rel" in
    programs/wasm32/*|programs/wasm64/*) ;;  # explicit arch — pass through
    programs/*)
        adjusted="programs/wasm32/${rel#programs/}"
        ;;
esac

local_path="$repo_root/local-binaries/$adjusted"
fetched_path="$repo_root/binaries/$adjusted"
current_abi="$(wasm_current_abi_version "$repo_root" || true)"

is_stale_wasm_artifact() {
    wasm_has_legacy_asyncify "$1" ||
        wasm_has_stale_abi "$1" "$current_abi" ||
        wasm_has_missing_fork_instrumentation "$1"
}

if [ -e "$local_path" ]; then
    if [ -e "$fetched_path" ] \
        && is_stale_wasm_artifact "$local_path" \
        && ! is_stale_wasm_artifact "$fetched_path"; then
        echo "$fetched_path"
        exit 0
    fi
    if is_stale_wasm_artifact "$local_path"; then
        echo "ERROR: stale wasm artifact ignored: $local_path" >&2
        echo "       Rebuild it for ABI ${current_abi:-current}, fetch a fresh release, or remove the stale local override." >&2
        exit 1
    fi
    echo "$local_path"
    exit 0
fi
if [ -e "$fetched_path" ]; then
    if is_stale_wasm_artifact "$fetched_path"; then
        echo "ERROR: stale wasm artifact ignored: $fetched_path" >&2
        echo "       Rebuild it for ABI ${current_abi:-current} or fetch a fresh release." >&2
        exit 1
    fi
    echo "$fetched_path"
    exit 0
fi

cat >&2 <<EOF
ERROR: binary not found: $rel
  checked: $local_path
  checked: $fetched_path
  Run scripts/fetch-binaries.sh or place a file at local-binaries/$adjusted.
EOF
exit 1
