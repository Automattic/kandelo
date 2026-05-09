#!/usr/bin/env bash
set -euo pipefail

# Build the canonical rootfs.vfs image from the top-level MANIFEST +
# rootfs/ source tree, using the mkrootfs CLI under tools/mkrootfs/.
# Output: host/wasm/rootfs.vfs (gitignored — built artifact).
#
# This is a Node.js/TypeScript invocation, not a wasm cross-compile,
# so it does not need scripts/dev-shell.sh — only `node` and `npx`
# from PATH (npx pulls tsx via the host package's devDeps).

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# mkrootfs depends on the host package (file:../../host) for its VFS
# writer + fzstd; install both trees if missing.
if [ ! -d host/node_modules ]; then
    echo "==> Installing host/ dependencies (needed by mkrootfs)..."
    (cd host && npm install --prefer-offline --silent)
fi
if [ ! -d tools/mkrootfs/node_modules ]; then
    echo "==> Installing tools/mkrootfs/ dependencies..."
    (cd tools/mkrootfs && npm install --prefer-offline --silent)
fi

OUT="host/wasm/rootfs.vfs"
mkdir -p "$(dirname "$OUT")"

echo "==> Building rootfs.vfs from MANIFEST + rootfs/..."
node tools/mkrootfs/bin/mkrootfs.mjs build MANIFEST rootfs \
    -o "$OUT" \
    --repo-root "$REPO_ROOT"

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "==> Built $OUT ($SIZE bytes)"
