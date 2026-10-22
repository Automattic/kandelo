#!/usr/bin/env bash
# Build the in-tree lsof.c (a small /proc reader) for wasm32-posix-kernel.
# Source: examples/lsof.c.  Not the upstream lsof — this is a minimal
# implementation tailored to this kernel's procfs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
SRC="$SOURCE_ROOT/examples/lsof.c"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
OUT_BIN="$WORK_DIR/lsof.wasm"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

if [ ! -f "$SRC" ] || [ -L "$SRC" ]; then
    echo "ERROR: lsof source must be a regular file: $SRC" >&2
    exit 1
fi

# Use the SDK's link contract, including compiler facts and optimization
# ordering, rather than a recipe-owned copy of its compiler/linker flags.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
echo "==> Building lsof.wasm from $SRC"
wasm32posix-cc -O2 -fno-trapping-math "$SRC" -o "$OUT_BIN"

ls -lh "$OUT_BIN"
echo "==> lsof built successfully!"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lsof "$OUT_BIN"
