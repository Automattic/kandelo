#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Package-only policy: put this flag first, followed by the linked input.
# Keep the CLI's diagnostic/fallback modes available to non-package callers.
REQUIRE_FACTS=0
if [ "${1:-}" = --require-facts ]; then
    REQUIRE_FACTS=1
    shift
    if [ ! -f "${1:-}" ]; then
        echo "usage: run-wasm-fork-instrument.sh --require-facts <input.wasm> [options]" >&2
        exit 2
    fi
fi

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

if [ "$REQUIRE_FACTS" = 1 ]; then
    # shellcheck source=wasm-artifact-guards.sh
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    # Check the same analysis options as the real invocation. Only output
    # operands conflict with --sink-report; never let --no-facts or another
    # planning option bypass the package policy by checking a different plan.
    check_args=()
    skip_output=0
    for arg in "${@:2}"; do
        if [ "$skip_output" = 1 ]; then
            skip_output=0
            continue
        fi
        case "$arg" in
            -o|--output) skip_output=1 ;;
            -o?*|--output=*) ;;
            *) check_args+=("$arg") ;;
        esac
    done
    wasm_require_fork_compiler_facts "$1" "$TOOL" ${check_args[@]+"${check_args[@]}"}
fi

exec "$TOOL" "$@"
