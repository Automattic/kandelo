#!/usr/bin/env bash
# Build the unchanged codecs bundled with the pinned Node reference release.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
case "$ARCH" in wasm32|wasm64) ;; *) echo "ERROR: unsupported codec target $ARCH" >&2; exit 2 ;; esac
if [ -z "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    # A direct invocation has the same separate, single-writer roots as a
    # resolver invocation; it never builds inside the reviewed recipe tree.
    CODECS_DIRECT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-node-codecs-$ARCH.XXXXXX")"
    mkdir -p "$CODECS_DIRECT_ROOT/work" "$CODECS_DIRECT_ROOT/out"
    export WASM_POSIX_DEP_WORK_DIR="$CODECS_DIRECT_ROOT/work"
    export WASM_POSIX_DEP_OUT_DIR="$CODECS_DIRECT_ROOT/out"
elif [ -z "${WASM_POSIX_DEP_WORK_DIR:-}" ] || [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    echo "ERROR: codec builds require both work and output roots" >&2
    exit 2
fi
kandelo_package_prepare_build_roots "$SCRIPT_DIR" "$ARCH"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SOURCE_DIR="$WORK_DIR/node-source"
kandelo_package_stage_primary_source node-codecs "$SOURCE_DIR" "$WORK_DIR"
source "$REPO_ROOT/sdk/activate.sh"
python3 "$SCRIPT_DIR/build-node-codecs.py" --source "$SOURCE_DIR" \
    --work "$WORK_DIR" --output "$KANDELO_PACKAGE_OUT_DIR" --arch "$ARCH"
