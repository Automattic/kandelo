#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE="$KANDELO_PACKAGE_SOURCE_ROOT/images/rootfs/etc/ssl/cert.pem"
[ -f "$SOURCE" ] && [ ! -L "$SOURCE" ] || {
    echo "ERROR: CA bundle source must be a regular non-symlink file" >&2
    exit 1
}
STAGE="$KANDELO_PACKAGE_WORK_DIR/stage"
mkdir -p "$STAGE/etc/ssl/certs"
# WHY: the browser replaces only ca-certificates.crt with its session CA.
# Two ordinary archive members retain independent guest-file identities.
cp "$SOURCE" "$STAGE/etc/ssl/cert.pem"
cp "$SOURCE" "$STAGE/etc/ssl/certs/ca-certificates.crt"
ARCHIVE="$KANDELO_PACKAGE_WORK_DIR/ca-certificates.zip"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$STAGE" "$ARCHIVE"
source "$REPO_ROOT/scripts/install-local-binary.sh"
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
install_local_binary ca-certificates "$ARCHIVE" ca-certificates.zip
