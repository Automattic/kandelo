#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
committed="$repo_root/scripts/resolve-binary.bundle.mjs"
generated_dir="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-resolver-bundle.XXXXXX")"
generated="$generated_dir/resolve-binary.bundle.mjs"
trap 'rm -rf "$generated_dir"' EXIT

if [ ! -f "$committed" ] || [ -L "$committed" ]; then
    echo "test-resolve-binary-bundle: committed bundle must be a regular non-symlink file" >&2
    exit 1
fi

bash "$repo_root/scripts/build-resolve-binary-bundle.sh" "$generated" >/dev/null
if ! cmp "$committed" "$generated" >/dev/null; then
    echo "test-resolve-binary-bundle: scripts/resolve-binary.bundle.mjs is stale" >&2
    echo "  regenerate it with: bash scripts/build-resolve-binary-bundle.sh" >&2
    exit 1
fi
load_err="${generated}.err"
if node "$generated" 2>"$load_err"; then
    echo "test-resolve-binary-bundle: no-argument standalone bundle unexpectedly succeeded" >&2
    exit 1
fi
if ! grep -F "usage: scripts/resolve-binary.sh" "$load_err" >/dev/null; then
    echo "test-resolve-binary-bundle: standalone copy could not load without node_modules" >&2
    sed -n '1,20p' "$load_err" >&2
    exit 1
fi

# The CLI bundle lives under scripts/, while the runtime resolver lives in
# host/src/. Both must see the canonical fallback under host/wasm/.
fixture="$generated_dir/checkout"
mkdir -p "$fixture/scripts" "$fixture/host/wasm"
cp "$generated" "$fixture/scripts/"
printf '[workspace]\n' > "$fixture/Cargo.toml"
printf '{"name":"kandelo"}\n' > "$fixture/package.json"
touch "$fixture/host/wasm/rootfs.vfs.zst"
(
    cd "$fixture"
    unset WASM_POSIX_RESOLUTION_POLICY WASM_POSIX_BINARY_RESOLVER_REPO_ROOT
    node scripts/resolve-binary.bundle.mjs --check-candidates rootfs.vfs.zst programs/rootfs.vfs.zst
    [ "$(node scripts/resolve-binary.bundle.mjs rootfs.vfs.zst)" = "$(pwd -P)/host/wasm/rootfs.vfs.zst" ]
    rm host/wasm/rootfs.vfs.zst
    if node scripts/resolve-binary.bundle.mjs --check-candidates rootfs.vfs.zst programs/rootfs.vfs.zst 2> "$load_err"; then
        echo "test-resolve-binary-bundle: absent rootfs was admitted" >&2
        exit 1
    fi
    grep -q 'No artifact candidate for rootfs.vfs.zst' "$load_err"
)

echo "test-resolve-binary-bundle: ok"
