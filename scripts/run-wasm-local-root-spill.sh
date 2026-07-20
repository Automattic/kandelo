#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CALLER_WORK_ROOT=""
CALLER_TOOL_ROOT=""

if [ -n "${WASM_POSIX_LOCAL_ROOT_SPILL:-}" ]; then
    TOOL="$WASM_POSIX_LOCAL_ROOT_SPILL"
elif [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    # A sealed package build can read the Kandelo checkout but cannot populate
    # its target/ or tools/bin/ directories. Build this native helper under a
    # fresh caller-owned root and execute only that exact regular file.
    if [ ! -d "$WASM_POSIX_DEP_WORK_DIR" ] || [ -L "$WASM_POSIX_DEP_WORK_DIR" ]; then
        echo "ERROR: WASM_POSIX_DEP_WORK_DIR must be a real directory for wasm-local-root-spill" >&2
        exit 1
    fi
    CALLER_WORK_ROOT="$(cd "$WASM_POSIX_DEP_WORK_DIR" && pwd -P)"
    CALLER_TOOL_ROOT="$(mktemp -d "$CALLER_WORK_ROOT/kandelo-local-root-spill.XXXXXX")"
    case "$CALLER_TOOL_ROOT/" in
        "$CALLER_WORK_ROOT"/*) ;;
        *)
            echo "ERROR: wasm-local-root-spill scratch escaped WASM_POSIX_DEP_WORK_DIR" >&2
            exit 1
            ;;
    esac
    TOOL="$CALLER_TOOL_ROOT/bin/wasm-local-root-spill"
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

    if [ -n "$CALLER_TOOL_ROOT" ]; then
        if ! CARGO_TARGET_DIR="$CALLER_TOOL_ROOT/target" \
            WASM_POSIX_LOCAL_ROOT_SPILL_OUT_DIR="$CALLER_TOOL_ROOT/bin" \
            bash "$REPO_ROOT/scripts/build-local-root-spill-tool.sh"; then
            echo "ERROR: failed to build wasm-local-root-spill inside WASM_POSIX_DEP_WORK_DIR" >&2
            exit 1
        fi
        if [ ! -f "$TOOL" ] || [ -L "$TOOL" ] || [ ! -x "$TOOL" ]; then
            echo "ERROR: caller-owned wasm-local-root-spill output is not a regular executable" >&2
            exit 1
        fi
    else
        bash "$REPO_ROOT/scripts/build-local-root-spill-tool.sh"
    fi
fi

exec "$TOOL" "$@"
