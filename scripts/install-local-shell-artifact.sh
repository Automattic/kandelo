#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

source_image="${1:-}"
install_session="${2:-}"
if [ -z "$source_image" ] || [ -z "$install_session" ] || [ "$#" -ne 2 ]; then
    echo "usage: $0 <shell.vfs.zst> <install-session>" >&2
    exit 2
fi
if [ ! -f "$source_image" ] || [ -L "$source_image" ]; then
    echo "install-local-shell-artifact: source image must be a regular non-symlink file: $source_image" >&2
    exit 1
fi
if ! [[ "$install_session" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "install-local-shell-artifact: install session is not a safe component" >&2
    exit 2
fi

resolved="$(bash scripts/resolve-binary.sh programs/shell.vfs.zst 2>/dev/null || true)"
if [ -n "$resolved" ] && [ -f "$resolved" ] && cmp -s "$source_image" "$resolved"; then
    echo "install-local-shell-artifact: exact shell bytes are already selected"
    exit 0
fi

host_target="$(rustc -vV | awk '/^host/ {print $2}')"
xtask="${WASM_POSIX_XTASK_BIN:-$REPO_ROOT/target/$host_target/release/xtask}"
if [ ! -f "$xtask" ] || [ ! -x "$xtask" ]; then
    echo "install-local-shell-artifact: missing executable package resolver: $xtask" >&2
    exit 1
fi

# WHY: the source-rootfs bridge and the final bottled shell are distinct
# recipes, but shell-derived VFS packages consume the canonical `shell`
# dependency name. This explicit local alias lets tests compose those
# dependents from already-inspected bridge bytes without publishing the bridge
# or weakening the canonical shell's pending artifact lock.
WASM_POSIX_LOCAL_INSTALL_SOURCE="$source_image" \
WASM_POSIX_LOCAL_INSTALL_SESSION="$install_session" \
    "$xtask" build-deps \
        --arch wasm32 \
        --binaries-dir "$REPO_ROOT/local-binaries" \
        install-local-artifact shell shell.vfs.zst

resolved="$(bash scripts/resolve-binary.sh programs/shell.vfs.zst)"
[ -f "$resolved" ] || {
    echo "install-local-shell-artifact: installed shell did not resolve" >&2
    exit 1
}
cmp "$source_image" "$resolved" || {
    echo "install-local-shell-artifact: resolver selected different shell bytes" >&2
    exit 1
}
