#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${WASM_POSIX_FORK_INSTRUMENT:-}" ]; then
    TOOL="$WASM_POSIX_FORK_INSTRUMENT"
else
    TOOL="$REPO_ROOT/tools/bin/wasm-fork-instrument"
fi

if [ -n "${WASM_POSIX_FORK_INSTRUMENT:-}" ]; then
    if [ ! -x "$TOOL" ]; then
        echo "ERROR: WASM_POSIX_FORK_INSTRUMENT is not executable: $TOOL" >&2
        exit 1
    fi
else
    STAMP="$TOOL.input-hash"
    # shellcheck source=fork-instrument-tool-input-hash.sh
    source "$REPO_ROOT/scripts/fork-instrument-tool-input-hash.sh"

    if ! command -v git >/dev/null 2>&1; then
        echo "ERROR: git is required to validate the repository fork instrumenter." >&2
        exit 1
    fi
    EXPECTED_INPUT_HASH="$(fork_instrument_tool_input_hash "$REPO_ROOT")"
    INSTALLED_INPUT_HASH=""
    if [ -f "$STAMP" ]; then
        IFS= read -r INSTALLED_INPUT_HASH < "$STAMP" || true
    fi

    if [ ! -x "$TOOL" ] || [ "$INSTALLED_INPUT_HASH" != "$EXPECTED_INPUT_HASH" ]; then
        if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
            echo "ERROR: current wasm-fork-instrument is unavailable, and cargo/rustc are not on PATH." >&2
            echo "       Run inside scripts/dev-shell.sh or set WASM_POSIX_FORK_INSTRUMENT." >&2
            exit 1
        fi
        bash "$REPO_ROOT/scripts/build-fork-instrument-tool.sh"
    fi

    INSTALLED_INPUT_HASH=""
    if [ -f "$STAMP" ]; then
        IFS= read -r INSTALLED_INPUT_HASH < "$STAMP" || true
    fi
    if [ ! -x "$TOOL" ] || [ "$INSTALLED_INPUT_HASH" != "$EXPECTED_INPUT_HASH" ]; then
        echo "ERROR: failed to install wasm-fork-instrument for the current repository sources." >&2
        echo "       Run inside scripts/dev-shell.sh, run scripts/build-fork-instrument-tool.sh, or set WASM_POSIX_FORK_INSTRUMENT." >&2
        exit 1
    fi
fi

exec "$TOOL" "$@"
