#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$here"
kandelo_package_prepare_build_roots "$here" wasm32
work="$KANDELO_PACKAGE_WORK_DIR"
source_dir="$work/src"

source "$repo/sdk/activate.sh"
kandelo_package_stage_primary_source zigcli "$source_dir" "$work"
export ZIG_GLOBAL_CACHE_DIR="$work/zig-global-cache"
export ZIG_LOCAL_CACHE_DIR="$work/zig-local-cache"

cd "$source_dir"
archive_name="${WASM_POSIX_DEP_SOURCE_URL##*/}"
zig build install-tree install-loc install-hexdump \
    -Dtarget=wasm32-kandelo-musl -Doptimize=ReleaseSafe \
    -Dversion="$WASM_POSIX_DEP_VERSION" \
    -Dgit_commit="${archive_name%.tar.gz}" \
    -Dbuild_date=2026-10-09 \
    --prefix "$work/install"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$repo/scripts/install-local-binary.sh"
for program in tree loc hexdump; do
    install_local_binary zigcli "$work/install/bin/$program.wasm" "$program.wasm"
done
