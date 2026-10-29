# shellcheck shell=bash
# Sourced by the Node.js conformance runners (run-libc-tests.sh,
# run-posix-tests.sh, run-sortix-tests.sh) after abi_contract_stamp_prepare.
#
# Every test runs its own `node examples/run-example.ts`, and the binary
# resolver in each one checks the program package index before resolving the
# test's built-in programs (`build-deps program-index-context-ensure`). Given
# no WASM_POSIX_XTASK_BIN, each process first runs `rustc -vV` and
# `cargo build -p xtask` into one shared target directory, 18 at a time. In
# PR #1596's Sortix run one test failed before it started: its ensure process
# died without a word (no exit status, no output), as a process killed by a
# signal does.
#
# conformance_program_index_prepare hands every test the release xtask the
# runner already built, and runs the ensure once before the fan-out, so a
# drifted index is rewritten once, loudly, before any test runs. Each test
# still runs its own ensure: that is the resolver's freshness contract, and
# after this pass it only compares.
conformance_program_index_prepare() {
    if [ -z "${KANDELO_ABI_STAMP_XTASK:-}" ]; then
        echo "Error: abi_contract_stamp_prepare was not called" >&2
        return 1
    fi
    export WASM_POSIX_XTASK_BIN="$KANDELO_ABI_STAMP_XTASK"
    if ! WASM_POSIX_DEPS_REGISTRY="${WASM_POSIX_DEPS_REGISTRY:-$REPO_ROOT/packages/registry}" \
        "$WASM_POSIX_XTASK_BIN" build-deps program-index-context-ensure \
            --source-repo-root "$REPO_ROOT"; then
        echo "Error: the program package index could not be brought up to date before running tests." >&2
        return 1
    fi
}
