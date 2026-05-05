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
# carry workflow-context vars through (auth tokens, dispatch
# inputs, ref/sha names). `CI`, `LOGNAME`, `USER` carry GHA-runner
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

exec nix develop \
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
    --keep GITHUB_TOKEN \
    --keep GITHUB_REPOSITORY \
    --keep GITHUB_REF \
    --keep GITHUB_REF_NAME \
    --keep GITHUB_SHA \
    --keep GITHUB_RUN_ID \
    --keep GITHUB_ACTIONS \
    --keep WASM_POSIX_DEP_TARGET_ARCH \
    --keep WASM_POSIX_DEP_OUT_DIR \
    --keep WASM_POSIX_DEP_NAME \
    --keep WASM_POSIX_DEP_VERSION \
    --keep WASM_POSIX_SYSROOT \
    --keep WASM_POSIX_LLVM_DIR \
    --accept-flake-config \
    --command "$@"
