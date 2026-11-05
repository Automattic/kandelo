#!/usr/bin/env bash
# Exact Node-vendored parser, normal SDK/resolver/private-sysroot ownership.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
case "$ARCH" in wasm32) BASE_SYSROOT="$REPO_ROOT/sysroot";; wasm64) BASE_SYSROOT="$REPO_ROOT/sysroot64";; *) exit 2;; esac
kandelo_package_prepare_build_roots "$SCRIPT_DIR" "$ARCH"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SOURCE_DIR="$WORK_DIR/node-source"
kandelo_package_stage_primary_source node-simdjson "$SOURCE_DIR" "$WORK_DIR"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT
WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot node-simdjson "$BASE_SYSROOT" libcxx)"
python3 "$SCRIPT_DIR/build-node-simdjson.py" --source "$SOURCE_DIR" \
    --work "$WORK_DIR" --output "$KANDELO_PACKAGE_OUT_DIR" --arch "$ARCH"
