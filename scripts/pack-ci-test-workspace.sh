#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

out="${1:-}"
if [ -z "$out" ]; then
    echo "usage: $0 <out.tar.zst>" >&2
    exit 2
fi

for required in \
    local-binaries/kernel.wasm \
    host/wasm/rootfs.vfs \
    examples/gencat.wasm \
    examples/pthread_channel_reuse_test.wasm \
    examples/wait_lifecycle_test.wasm \
    examples/wait_lifecycle_test.wasm64.wasm; do
    if [ ! -f "$required" ]; then
        echo "pack-ci-test-workspace: missing required artifact: $required" >&2
        exit 1
    fi
done

items=()
for item in binaries local-binaries host/wasm; do
    [ -e "$item" ] && items+=("$item")
done
for wasm in examples/*.wasm; do
    [ -f "$wasm" ] && items+=("$wasm")
done

mkdir -p "$(dirname "$out")"
tar --zstd -chf "$out" "${items[@]}"
