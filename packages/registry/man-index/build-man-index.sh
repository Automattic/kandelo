#!/usr/bin/env bash
# Build mandoc.db for the shell's manual pages.
#
# The index is built on the build host: mandoc compiled natively from the
# same pinned source as the guest's mandoc runs as makewhatis over every
# page the docs packages ship, laid out as the shell mounts them
# (/usr/share/man). makewhatis records paths relative to that directory, so
# the database reads the same at /usr/share/man/mandoc.db in the guest.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"

SRC="$WORK/mandoc-host-src"
rm -rf "$SRC"
kandelo_package_stage_verified_source mandoc "$SRC" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$WASM_POSIX_DEP_SOURCE_URL" \
    "$WASM_POSIX_DEP_SOURCE_SHA256" "$WORK"

echo "==> Building a host mandoc for makewhatis..."
(
    cd "$SRC"
    # The host build only runs makewhatis in this script; it installs
    # nothing, so the install paths are never used.
    printf 'PREFIX=%s\n' "$WORK/mandoc-host-unused" > configure.local
    ./configure > configure.log 2>&1 || { tail -40 configure.log >&2; exit 1; }
    make -j4 mandoc > make.log 2>&1 || { tail -40 make.log >&2; exit 1; }
)
ln -sf mandoc "$SRC/makewhatis"

# Every docs package is a direct dependency; each ships one ZIP of
# share/man pages mounted at /usr/.
MANROOT="$WORK/root"
rm -rf "$MANROOT"
mkdir -p "$MANROOT"
count=0
while IFS= read -r variable; do
    dir="${!variable}"
    zips=("$dir"/*.zip)
    [ "${#zips[@]}" -eq 1 ] && [ -f "${zips[0]}" ] || {
        echo "build-man-index: $variable must hold exactly one docs ZIP: $dir" >&2
        exit 1
    }
    unzip -q -o "${zips[0]}" -d "$MANROOT"
    count=$((count + 1))
done < <(compgen -v WASM_POSIX_DEP_ | grep -E '^WASM_POSIX_DEP_[A-Z0-9_]+_DOCS_DIR$' | sort)
[ "$count" -gt 0 ] || { echo "build-man-index: no docs dependencies" >&2; exit 1; }
[ -d "$MANROOT/share/man" ] || { echo "build-man-index: no share/man in the docs ZIPs" >&2; exit 1; }

echo "==> Indexing $(find "$MANROOT/share/man" -type f | wc -l | tr -d ' ') pages from $count docs packages..."
"$SRC/makewhatis" "$MANROOT/share/man"
DB="$MANROOT/share/man/mandoc.db"
[ -s "$DB" ] || { echo "build-man-index: makewhatis wrote no mandoc.db" >&2; exit 1; }

# Published as man-index.db (the package's output name); the shell mounts
# it at /usr/share/man/mandoc.db, where mandoc looks for it.
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary man-index "$DB" man-index.db
