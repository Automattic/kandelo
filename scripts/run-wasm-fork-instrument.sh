#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${WASM_POSIX_FORK_INSTRUMENT:-}" ]; then
    TOOL="$WASM_POSIX_FORK_INSTRUMENT"
else
    TOOL="$REPO_ROOT/tools/bin/wasm-fork-instrument"
fi

if [ ! -x "$TOOL" ]; then
    if [ -n "${WASM_POSIX_FORK_INSTRUMENT:-}" ]; then
        echo "ERROR: WASM_POSIX_FORK_INSTRUMENT is not executable: $TOOL" >&2
        exit 1
    fi

    if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
        echo "ERROR: wasm-fork-instrument not found at $TOOL, and cargo/rustc are not on PATH." >&2
        echo "       Run inside scripts/dev-shell.sh, run scripts/build-fork-instrument-tool.sh, or set WASM_POSIX_FORK_INSTRUMENT." >&2
        exit 1
    fi

    bash "$REPO_ROOT/scripts/build-fork-instrument-tool.sh"
fi

extra_args=()
case "${WASM_POSIX_FORK_FRAME_COUNTER:-}" in
    ""|0|false|False|FALSE)
        ;;
    1|true|True|TRUE)
        extra_args+=(--frame-counter)
        ;;
    *)
        echo "ERROR: WASM_POSIX_FORK_FRAME_COUNTER must be 1/true or 0/false, got '${WASM_POSIX_FORK_FRAME_COUNTER}'." >&2
        exit 1
        ;;
esac

exec "$TOOL" "${extra_args[@]}" "$@"
