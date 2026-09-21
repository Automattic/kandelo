#!/usr/bin/env bash
# Package the authored lsof(8) man page (packages/registry/lsof-docs/lsof.8)
# as a root-relative lazy-archive zip. Kandelo's lsof (examples/lsof.c) is
# not upstream lsof, so this page is authored in-tree rather than vendored;
# there is nothing to compile here, only staging and zipping.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32

STAGE="$KANDELO_PACKAGE_WORK_DIR/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/share/man/man8"
cp "$SCRIPT_DIR/lsof.8" "$STAGE/share/man/man8/lsof.8"

ARCHIVE="$KANDELO_PACKAGE_WORK_DIR/lsof-docs.zip"
rm -f "$ARCHIVE"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$STAGE" "$ARCHIVE"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        install_local_binary lsof-docs "$ARCHIVE" lsof-docs.zip
else
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
        install_local_binary lsof-docs "$ARCHIVE" lsof-docs.zip
fi
