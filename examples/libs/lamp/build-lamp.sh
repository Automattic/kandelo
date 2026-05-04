#!/usr/bin/env bash
# package-system build wrapper for the LAMP-stack VFS image (WordPress + MariaDB).
# Delegates to examples/browser/scripts/build-lamp-vfs-image.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Same WordPress-source bootstrap as build-wordpress.sh — see that file
# for rationale. Idempotent.
bash "$REPO_ROOT/examples/wordpress/setup.sh"

bash "$REPO_ROOT/examples/browser/scripts/build-lamp-vfs-image.sh"

VFS="$REPO_ROOT/examples/browser/public/lamp.vfs"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lamp "$VFS"
