#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [ -z "${KANDELO_DEV_SHELL_TOOL_PATH:-}" ]; then
    exec bash scripts/dev-shell.sh bash "$repo_root/scripts/test-wasmtime-smoke.sh" "$@"
fi

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <freshly built wasm32 kernel.wasm>" >&2
    exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-wasmtime-smoke.XXXXXX")"
trap 'rm -- "$work/guest.wasm" "$work/rootfs.vfs" 2>/dev/null || true; rmdir -- "$work"' EXIT
host_target="$(rustc -vV | sed -n 's/^host: //p')"
wasm32posix-cc -O2 crates/host-native/smoke.c -o "$work/guest.wasm"
cargo build --locked -p host-native --target "$host_target"
runner="${CARGO_TARGET_DIR:-target}/$host_target/debug/host-native"
"$runner" image "$work/rootfs.vfs"
"$runner" run "$1" "$work/rootfs.vfs" "$work/guest.wasm"
