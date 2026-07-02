#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${WASM_POSIX_LOCAL_ROOT_SPILL:-}" ]; then
    TOOL="$WASM_POSIX_LOCAL_ROOT_SPILL"
else
    TOOL="$REPO_ROOT/tools/bin/wasm-local-root-spill"
fi

if [ ! -x "$TOOL" ]; then
    if [ -n "${WASM_POSIX_LOCAL_ROOT_SPILL:-}" ]; then
        echo "ERROR: WASM_POSIX_LOCAL_ROOT_SPILL is not executable: $TOOL" >&2
        exit 1
    fi

    if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
        echo "ERROR: wasm-local-root-spill not found at $TOOL, and cargo/rustc are not on PATH." >&2
        echo "       Run inside scripts/dev-shell.sh, run scripts/build-local-root-spill-tool.sh, or set WASM_POSIX_LOCAL_ROOT_SPILL." >&2
        exit 1
    fi

    bash "$REPO_ROOT/scripts/build-local-root-spill-tool.sh"
fi

exec "$TOOL" "$@"
