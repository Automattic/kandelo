#!/usr/bin/env bash
# package-system build wrapper for the WordPress VFS image.
# Delegates to examples/browser/scripts/build-wp-vfs-image.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# WordPress PHP source (and the SQLite db.php drop-in) live outside the
# package.toml registry — they're downloaded by examples/wordpress/setup.sh
# into examples/wordpress/{wordpress,sqlite-database-integration}/. The
# vfs-image builder reads from there. setup.sh is idempotent: it skips
# downloads when the trees are already present.
bash "$REPO_ROOT/examples/wordpress/setup.sh"

bash "$REPO_ROOT/examples/browser/scripts/build-wp-vfs-image.sh"

VFS="$REPO_ROOT/examples/browser/public/wordpress.vfs"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary wordpress "$VFS"
