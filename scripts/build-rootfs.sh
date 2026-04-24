#!/bin/bash
# Build the rootfs VFS image consumed by the kernel host at init time.
#
# Inputs:  rootfs/ source tree, top-level MANIFEST
# Output:  host/wasm/rootfs.vfs
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/host/wasm/rootfs.vfs"
mkdir -p "$(dirname "$OUT")"

"$REPO_ROOT/tools/mkrootfs/bin/mkrootfs.mjs" build \
    "$REPO_ROOT/rootfs" \
    "$REPO_ROOT/MANIFEST" \
    -o "$OUT" \
    "--repoRoot=$REPO_ROOT"
