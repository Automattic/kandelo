#!/usr/bin/env bash
#
# Build a Python stdlib VFS image for the browser demo.
# Produces: examples/browser/public/python.vfs
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_ROOT"

echo "==> Building Python VFS image..."
npx tsx "$SCRIPT_DIR/build-python-vfs-image.ts"

echo "==> Done."
ls -lh examples/browser/public/python.vfs
