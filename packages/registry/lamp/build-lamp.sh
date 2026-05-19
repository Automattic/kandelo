#!/usr/bin/env bash
# package-system build wrapper for the LAMP-stack VFS image (WordPress + MariaDB).
# Delegates to images/vfs/scripts/build-lamp-vfs-image.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Same WordPress-source bootstrap as build-wordpress.sh — see that file
# for rationale. Idempotent.
bash "$REPO_ROOT/packages/registry/wordpress/setup.sh"

# Build the lazy-archive zips consumed by populateShellEnvironment().
# lamp.vfs.zst bakes the eager shell environment, but vim/nethack are
# represented as zip archives derived from their resolver outputs, not
# as direct registry package outputs.
bash "$REPO_ROOT/images/vfs/scripts/build-vim-zip.sh"
bash "$REPO_ROOT/images/vfs/scripts/build-nethack-zip.sh"

# build-lamp-vfs-image.ts reads mariadbd.wasm + bootstrap SQL files from
# packages/registry/mariadb/mariadb-install/ — paths that build-mariadb.sh
# populates locally. Under the resolver chain on a clean cache (xtask
# build-deps / stage-pr-overlay), mariadb is a cache hit, so its source
# build never runs and mariadb-install/ stays empty. Back-fill the two
# things lamp needs:
#   * mariadbd.wasm: copy from $WASM_POSIX_DEP_MARIADB_DIR (the
#     resolver-extracted mariadb tarball; install_local_binary stages
#     the binary at the top level there).
#   * SQL bootstrap files: NOT in the mariadb tarball — fetch the
#     mariadb source tarball directly and extract just the two scripts.
# Both writes are idempotent; on a local dev workflow where
# build-mariadb.sh already populated mariadb-install/, this no-ops.
MARIADB_VERSION="10.5.28"
MARIADB_INSTALL="$REPO_ROOT/packages/registry/mariadb/mariadb-install"
mkdir -p "$MARIADB_INSTALL/bin" "$MARIADB_INSTALL/share/mysql"
if [ ! -f "$MARIADB_INSTALL/bin/mariadbd.wasm" ]; then
    if [ -n "${WASM_POSIX_DEP_MARIADB_DIR:-}" ] \
       && [ -f "$WASM_POSIX_DEP_MARIADB_DIR/mariadbd.wasm" ]; then
        cp "$WASM_POSIX_DEP_MARIADB_DIR/mariadbd.wasm" "$MARIADB_INSTALL/bin/"
        echo "==> Staged mariadbd.wasm from resolver dep dir"
    else
        echo "ERROR: mariadbd.wasm not found in WASM_POSIX_DEP_MARIADB_DIR=${WASM_POSIX_DEP_MARIADB_DIR:-<unset>}" >&2
        echo "       and no local build at $MARIADB_INSTALL/bin/mariadbd.wasm." >&2
        echo "       Run: bash packages/registry/mariadb/build-mariadb.sh" >&2
        exit 1
    fi
fi
if [ ! -f "$MARIADB_INSTALL/share/mysql/mysql_system_tables.sql" ] \
   || [ ! -f "$MARIADB_INSTALL/share/mysql/mysql_system_tables_data.sql" ]; then
    echo "==> Fetching mariadb source for bootstrap SQL files..."
    TARBALL="/tmp/mariadb-${MARIADB_VERSION}.tar.gz"
    if [ ! -f "$TARBALL" ]; then
        URL="https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/source/mariadb-${MARIADB_VERSION}.tar.gz"
        curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
             -fsSL "$URL" -o "$TARBALL"
    fi
    tar xzf "$TARBALL" -C "$MARIADB_INSTALL/share/mysql" --strip-components=2 \
        "mariadb-${MARIADB_VERSION}/scripts/mysql_system_tables.sql" \
        "mariadb-${MARIADB_VERSION}/scripts/mysql_system_tables_data.sql"
    echo "==> Extracted bootstrap SQL"
fi

bash "$REPO_ROOT/images/vfs/scripts/build-lamp-vfs-image.sh"

VFS="$REPO_ROOT/apps/browser-demos/public/lamp.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lamp "$VFS"
