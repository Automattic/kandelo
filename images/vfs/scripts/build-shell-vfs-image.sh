#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building Shell VFS image..."
npx tsx "$SCRIPT_DIR/build-shell-vfs-image.ts"
echo "==> Done."
ls -lh apps/browser-demos/public/shell.vfs.zst

# Mirror into local-binaries/ so the browser demo's @binaries/ alias resolves
# to the freshly generated shell image during local development.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary shell "$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
