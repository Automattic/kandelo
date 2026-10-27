#!/usr/bin/env bash
# calltypes-plugin.sh <clang>: print the KandeloCallTypes compiler plugin
# built for <clang>, building it first if needed. For builds that compile
# with clang directly instead of through the SDK driver (musl, libc++); the
# driver (crates/kandelo-cc) owns the plugin cache.
WASM_POSIX_INVOKED_AS=kandelo-cc
export WASM_POSIX_INVOKED_AS
set -- calltypes-plugin "$@"
. "$(dirname "$0")/../sdk/src/kandelo-cc.sh"
