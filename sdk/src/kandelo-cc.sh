# shellcheck shell=bash
# Run this worktree's SDK driver (crates/kandelo-cc) as the tool named by
# WASM_POSIX_INVOKED_AS. Sourced by every sdk/bin wrapper, so "$@" is the
# caller's arguments.
#
# The driver is a native program built from this checkout on first use and
# rebuilt whenever its sources change (scripts/build-kandelo-cc.sh). Build
# progress goes to stderr: configure scripts read a compiler's stdout.
__kandelo_sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
__kandelo_repo="$(dirname "$__kandelo_sdk")"
__kandelo_cc="$__kandelo_sdk/.build/bin/kandelo-cc"
if [ ! -f "$__kandelo_repo/crates/kandelo-cc/Cargo.toml" ]; then
    echo "${WASM_POSIX_INVOKED_AS:-kandelo-cc}: the SDK driver is built from a Kandelo checkout, and $__kandelo_repo is not one" >&2
    exit 1
fi
# shellcheck source=kandelo-cc-inputs.sh
. "$__kandelo_sdk/src/kandelo-cc-inputs.sh"
__kandelo_stamp="$(kandelo_cc_inputs_stamp "$__kandelo_repo")" || exit 1
if [ ! -x "$__kandelo_cc" ] || [ "$__kandelo_stamp" != "$(cat "$__kandelo_cc.inputs" 2>/dev/null)" ]; then
    bash "$__kandelo_repo/scripts/build-kandelo-cc.sh" >&2 || exit 1
fi
exec "$__kandelo_cc" "$@"
