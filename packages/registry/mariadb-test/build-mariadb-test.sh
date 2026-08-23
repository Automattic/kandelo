#!/usr/bin/env bash
# package-system build wrapper for the MariaDB test VFS image.
#
# Calls the existing browser-side builder with MARIADB_TEST_VFS_OUT
# pointed at a staging path so install_local_binary picks up
# `mariadb-test.vfs.zst` (matching the manifest's program name).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"

mkdir -p "$WORK_DIR"
STAGE="$WORK_DIR/mariadb-test.vfs.zst"
MARIADB_TEST_TSX_TMP="$(mktemp -d /tmp/kandelo-mariadb-test.XXXXXX)"
trap 'rm -rf -- "$MARIADB_TEST_TSX_TMP"' EXIT
MARIADB_TEST_VFS_OUT="$STAGE" \
    TMPDIR="$MARIADB_TEST_TSX_TMP" \
    node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$REPO_ROOT/images/vfs/scripts/build-mariadb-test-vfs-image.ts" "$@"
[ -f "$STAGE" ] || { echo "ERROR: $STAGE not produced" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary mariadb-test "$STAGE"
