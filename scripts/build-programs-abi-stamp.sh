#!/usr/bin/env bash
# Sourced by scripts/build-programs.sh: record each .wasm the run writes, then
# stamp exactly those with this checkout's kandelo.abi.contract digest.
#
# WHY only recorded outputs: the output trees also hold .wasm files that other
# producers wrote, such as the examples/*.wasm64.wasm fixtures Vitest builds
# on demand, and outputs of earlier runs that this run skipped. After an ABI
# change those carry the previous digest, and `xtask stamp-abi-contract`
# correctly refuses to restamp them. Sweeping them into the stamp list made
# the whole run fail on files it did not build. Leaving them untouched keeps
# them truthful: the host refuses a guest whose stamped digest differs from
# the kernel's, and the Vitest fixture builders rebuild their own stale
# outputs. A run must never stamp a file it did not build, because that would
# make an artifact of unknown provenance look current.
#
# Callers set REPO_ROOT before sourcing. HOST_TARGET is optional.

BUILT_PROGRAM_OUTPUTS=()

record_built_program_output() {
    BUILT_PROGRAM_OUTPUTS+=("$1")
}

stamp_built_program_outputs() {
    # Bash 3.2 under `set -u` treats an empty array expansion as unbound.
    [ "${#BUILT_PROGRAM_OUTPUTS[@]}" -gt 0 ] || return 0
    local host_target="${HOST_TARGET:-}"
    if [ -z "$host_target" ]; then
        host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    fi
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$host_target" --quiet -- \
        stamp-abi-contract "${BUILT_PROGRAM_OUTPUTS[@]}")
}
