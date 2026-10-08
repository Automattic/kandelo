#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building MariaDB VFS image..."
npx tsx "$SCRIPT_DIR/build-mariadb-vfs-image.ts" "$@"
echo "==> Done."
# A non-flag argument is the output path; otherwise the builder writes the
# browser demo's public/ copy.
VFS=""
for arg in "$@"; do
    case "$arg" in
        --*) ;;
        *) VFS="$arg" ;;
    esac
done
if [ -n "$VFS" ]; then
    ls -lh "$VFS"
elif [[ "$*" == *--wasm64* ]]; then
    ls -lh apps/browser-demos/public/mariadb-64.vfs.zst
else
    ls -lh apps/browser-demos/public/mariadb.vfs.zst
fi
