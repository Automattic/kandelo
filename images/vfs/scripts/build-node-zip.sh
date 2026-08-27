#!/usr/bin/env bash
#
# Build node.zip for the browser shell demo: a root-relative archive of
# bin/node (the SpiderMonkey-based Node.js interpreter). The shell overlay
# mounts it at /usr/, so the entry becomes /usr/bin/node. On first exec the
# archive is fetched and unpacked in one go.
#
# Node's core JavaScript modules and REPL line editing are compiled into the
# executable, so unlike python/ruby there is no external standard-library tree
# to stage — the single self-contained binary is the whole runtime.
#
#   build-node-zip.sh <node-dependency-dir> <output.zip>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

[ "$#" -eq 2 ] || { echo "usage: $0 <node-dependency-dir> <output.zip>" >&2; exit 2; }
NODE_DIR="$1"
OUTPUT_FILE="$2"

# The node package exposes its declared output directly in the dependency dir.
NODE_WASM="$NODE_DIR/node.wasm"
[ -f "$NODE_WASM" ] || { echo "node.wasm not found under $NODE_DIR" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    STAGING="$(mktemp -d "$WASM_POSIX_DEP_WORK_DIR/node-zip.XXXXXX")"
else
    STAGING="$(mktemp -d)"
fi
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging node.zip tree..."
mkdir -p "$STAGING/bin"
# The interpreter as bin/node (no .wasm extension).
cp "$NODE_WASM" "$STAGING/bin/node"
chmod 755 "$STAGING/bin/node"

# Exactly one regular executable named bin/node is required by the loader.
[ -f "$STAGING/bin/node" ] || { echo "bin/node missing" >&2; exit 1; }

OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"; mkdir -p "$OUTPUT_DIR"; rm -f "$OUTPUT_FILE"
bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"
echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"
