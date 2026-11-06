#!/usr/bin/env bash
# Build the Kandelo exchange userland: the agent (kxchgd), the helpers
# (kandelo-exchange, kandelo-publish) and the catch-all handler
# (exchange-save). Sources: programs/kandelo-exchange/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
kandelo_package_select_source_root "$REPO_ROOT"

SOURCE_DIR="$KANDELO_PACKAGE_SOURCE_ROOT/programs/kandelo-exchange"
PROGRAMS=(kxchgd kandelo-exchange kandelo-publish exchange-save)
for program in "${PROGRAMS[@]}"; do
    if [ ! -f "$SOURCE_DIR/$program.c" ] || [ -L "$SOURCE_DIR/$program.c" ]; then
        echo "ERROR: kandelo-exchange source must be a regular file: $SOURCE_DIR/$program.c" >&2
        exit 1
    fi
done

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] &&
   [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    # They start children with posix_spawn and never fork.
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
for program in "${PROGRAMS[@]}"; do
    wasm32posix-cc -std=c11 -O2 -Wall -Wextra -Werror \
        "$SOURCE_DIR/$program.c" -o "$KANDELO_PACKAGE_WORK_DIR/$program.wasm"
done

source "$REPO_ROOT/scripts/install-local-binary.sh"
for program in "${PROGRAMS[@]}"; do
    install_local_binary kandelo-exchange "$KANDELO_PACKAGE_WORK_DIR/$program.wasm" "$program.wasm"
done
