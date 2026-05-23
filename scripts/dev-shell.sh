#!/usr/bin/env bash
#
# Canonical entry to the wasm-posix-kernel dev shell.
#
# Always uses `nix develop --ignore-environment` so only flake.nix's
# declared `packages` are visible. Builds fail immediately on a
# missing dep rather than silently leaking a host tool from
# /usr/bin or /opt/homebrew — that latent class of bug is exactly
# what triggered PR #406 (force-rebuild's source-build path tripping
# over /usr/bin/curl, /opt/homebrew/bin/python3, /usr/bin/perl, etc.
# that the flake didn't declare).
#
# `--keep` preserves only the specific env vars CI workflows and
# interactive use need. `HOME` is required because cargo/npm/git
# all stash state under `~/`. The `INPUT_*` and `GITHUB_*` lists
# carry workflow-context vars through (dispatch inputs, ref/sha names).
# `GH_TOKEN` is kept for the GitHub CLI, while `GITHUB_TOKEN` is
# intentionally not kept so Nix does not treat a repo-scoped Actions
# token as a general-purpose token for public GitHub flake inputs.
# `CI`, `LOGNAME`, `USER` carry GHA-runner
# identity through to test scripts: `run-sortix-tests.sh` checks
# `${CI:-}` to skip flaky tests, and musl's `getlogin()` reads
# `LOGNAME`/`USER` (the os-test getlogin probe expects either a
# valid login name or NULL+ENOTTY/ENXIO; without LOGNAME it gets
# NULL+errno=0 and FAILs). PATH is intentionally NOT kept — Nix
# rebuilds it from the flake so anything that needs to leak from
# the host raises a "command not found" instead of building wrong.
#
# Usage:
#   scripts/dev-shell.sh bash scripts/build-musl.sh   # one-shot command
#   scripts/dev-shell.sh bash                         # interactive shell
#
# Workflow YAMLs invoke it via `bash scripts/dev-shell.sh ...`. To
# add a new keep, edit this file once — the keep-list is a single
# source of truth instead of being re-declared inline in every
# workflow step.

set -euo pipefail

if [ $# -eq 0 ]; then
    echo "usage: $0 <command> [args...]" >&2
    echo "  e.g.: $0 bash scripts/build-musl.sh" >&2
    echo "        $0 bash                       # interactive pure shell" >&2
    exit 2
fi

nix_develop=(
    nix develop
    --ignore-environment \
    --keep HOME \
    --keep TERM \
    --keep CI \
    --keep LOGNAME \
    --keep USER \
    --keep INPUT_PACKAGES \
    --keep INPUT_ARCHES \
    --keep INPUT_REF \
    --keep INPUT_SKIP_TESTS \
    --keep INPUT_BUMP_LOCKFILE \
    --keep GH_TOKEN \
    --keep GITHUB_REPOSITORY \
    --keep GITHUB_REF \
    --keep GITHUB_REF_NAME \
    --keep GITHUB_SHA \
    --keep GITHUB_RUN_ID \
    --keep GITHUB_ACTIONS \
    --keep GITHUB_OUTPUT \
    --keep GITHUB_ENV \
    --keep GITHUB_PATH \
    --keep GITHUB_STEP_SUMMARY \
    --keep GITHUB_WORKSPACE \
    --keep GITHUB_EVENT_NAME \
    --keep GITHUB_EVENT_PATH \
    --keep SYNTH_BASE_SHA \
    --keep SYNTH_HEAD_SHA \
    --keep SYNTHETIC_MERGE_SHA \
    --keep RUNNER_TEMP \
    --keep RUNNER_OS \
    --keep RUNNER_ARCH \
    --keep RUNNER_TOOL_CACHE \
    --keep RUNNER_NAME \
    --keep RUNNER_DEBUG \
    --keep WASM_POSIX_DEP_TARGET_ARCH \
    --keep WASM_POSIX_DEP_OUT_DIR \
    --keep WASM_POSIX_DEP_NAME \
    --keep WASM_POSIX_DEP_VERSION \
    --keep WASM_POSIX_BINARY_INDEX_URL \
    --keep WASM_POSIX_FETCH_SKIP_PKGS \
    --keep WASM_POSIX_SYSROOT \
    --keep WASM_POSIX_LLVM_DIR \
    --accept-flake-config \
    --command "$@"
)

is_transient_nix_fetch_failure() {
    local log_file="$1"

    # Nix already retries individual downloads quickly. Wrap the whole
    # shell entry with slower backoff for short GitHub archive outages.
    grep -Eq "unable to download 'https://(api\\.)?github\\.com/" "$log_file" &&
        grep -Eq 'HTTP error 5[0-9][0-9]|This page is taking too long to load|Bad Gateway|Service Unavailable' "$log_file"
}

attempt=1
max_attempts="${WASM_POSIX_DEV_SHELL_ATTEMPTS:-3}"
delay=5

while true; do
    log_file="$(mktemp)"
    set +e
    "${nix_develop[@]}" 2>&1 | tee "$log_file"
    rc="${PIPESTATUS[0]}"
    set -e

    if [ "$rc" -eq 0 ]; then
        rm -f "$log_file"
        exit 0
    fi

    if [ "$attempt" -ge "$max_attempts" ] || ! is_transient_nix_fetch_failure "$log_file"; then
        rm -f "$log_file"
        exit "$rc"
    fi

    echo "dev-shell.sh: transient GitHub flake fetch failure; retrying nix develop in ${delay}s (attempt ${attempt}/${max_attempts})." >&2
    rm -f "$log_file"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
done
