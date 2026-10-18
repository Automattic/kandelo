#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building Perl VFS image..."
# An optional argument is the output path (the resolver wrapper passes one
# under its work root); otherwise the browser demo's public/ copy.
VFS="${1:-apps/browser-demos/public/perl.vfs.zst}"
npx tsx "$SCRIPT_DIR/build-perl-vfs-image.ts" "$VFS"
echo "==> Done."
ls -lh "$VFS"
