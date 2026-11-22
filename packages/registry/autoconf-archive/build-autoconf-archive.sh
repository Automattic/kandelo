#!/usr/bin/env bash
# Build autoconf-archive for Kandelo as autoconf-archive.zip, mounted at /usr. See
# scripts/package-guest-script-tree.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
source "$REPO_ROOT/scripts/package-guest-script-tree.sh"
kandelo_package_guest_script_tree autoconf-archive autoconf-archive.zip
