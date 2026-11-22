#!/usr/bin/env bash
# Build GNU Libtool for Kandelo as libtool.zip, mounted at /usr. See
# scripts/package-guest-script-tree.sh. Configured through the SDK's
# configure wrapper, so the installed libtool script describes the guest
# (wasm32-unknown-linux-musl, wasm32posix-cc) rather than the build machine.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
source "$REPO_ROOT/scripts/package-guest-script-tree.sh"
KANDELO_GUEST_SCRIPT_CONFIGURE=wasm32posix-configure \
    kandelo_package_guest_script_tree libtool libtool.zip --disable-ltdl-install
