#!/bin/bash
# Sourced by the conformance runners (run-libc-tests.sh, run-posix-tests.sh,
# run-sortix-tests.sh) to stamp each test program they compile with this
# checkout's kandelo.abi.contract digest.
#
# WHY: the package build engine, scripts/build-programs.sh, and Vitest's
# global setup already stamp what they build. The runners compile their test
# programs a fourth way, and the host reports an unstamped guest as a "legacy
# binary [that] predates the ABI-contract-digest rollout" — false for a program
# compiled seconds earlier — and skips the ABI digest check for it.
#
# Call abi_contract_stamp_prepare once from the runner's main shell; it builds
# (or no-op checks) the release xtask and exports its path, so parallel build
# workers can call abi_contract_stamp without each paying for cargo.

abi_contract_stamp_prepare() {
    local host
    host="$(rustc -vV | sed -n 's/^host: //p')"
    if [ -z "$host" ]; then
        echo "Error: could not determine the Rust host target." >&2
        return 1
    fi
    (cd "$REPO_ROOT" && cargo build --release -p xtask --target "$host" --quiet) || return 1
    KANDELO_ABI_STAMP_XTASK="$REPO_ROOT/target/$host/release/xtask"
    if [ ! -x "$KANDELO_ABI_STAMP_XTASK" ]; then
        echo "Error: prepared xtask not found at $KANDELO_ABI_STAMP_XTASK" >&2
        return 1
    fi
    export KANDELO_ABI_STAMP_XTASK
}

abi_contract_stamp() {
    if [ -z "${KANDELO_ABI_STAMP_XTASK:-}" ]; then
        echo "Error: abi_contract_stamp_prepare was not called" >&2
        return 1
    fi
    "$KANDELO_ABI_STAMP_XTASK" stamp-abi-contract "$@" >/dev/null
}
export -f abi_contract_stamp
