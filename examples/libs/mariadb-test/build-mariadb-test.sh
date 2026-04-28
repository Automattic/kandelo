#!/usr/bin/env bash
# package-system build wrapper for the MariaDB test VFS image.
#
# Calls the existing browser-side builder with MARIADB_TEST_VFS_OUT
# pointed at a staging path so install_local_binary picks up
# `mariadb-test.vfs` (matching the manifest's program name).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

STAGE="$SCRIPT_DIR/mariadb-test.vfs"
MARIADB_TEST_VFS_OUT="$STAGE" \
    npx tsx "$REPO_ROOT/examples/browser/scripts/build-mariadb-test-vfs-image.ts" "$@"
[ -f "$STAGE" ] || { echo "ERROR: $STAGE not produced" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary mariadb-test "$STAGE"
