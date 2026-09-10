#!/usr/bin/env bash
#
# Run an xtask verb with the host target explicitly set.
#
# Why this wrapper exists
# -----------------------
# `.cargo/config.toml` sets `[build] target = "wasm32-unknown-unknown"` for the
# whole workspace, because that is what the kernel and the guest-side crates
# want. xtask is the exception: it is a host-side build tool. Running
#
#     cargo run -p xtask -- verify-fresh
#
# therefore tries to build xtask ITSELF for wasm32, where its transitive C
# dependencies (`ring` via `ureq`'s TLS feature, `zstd-sys`, `getrandom`) do
# not build. Under the nix dev shell, `NIX_HARDENING_ENABLE` also contributes
# `-fzero-call-used-regs=used-gpr`, which clang rejects for wasm32. The result
# is a long wall of cc-rs errors that names none of this, and in particular
# never mentions xtask or the target.
#
# The freshness gate -- the thing that makes stale artifacts fail loudly -- is
# an xtask verb, so left unwrapped it is unreachable by its obvious command.
#
# `forced-target` in `tools/xtask/Cargo.toml` would express this properly, but
# it is gated on the nightly-only `per-package-target` feature, which still
# panics in the cargo resolver on this repo's pinned toolchain (re-verified
# 2026-09-10). Until that is fixed upstream, this wrapper is the fix.
#
# Usage:
#     scripts/xtask.sh verify-fresh
#     scripts/xtask.sh bootstrap
#     ./scripts/dev-shell.sh scripts/xtask.sh verify-fresh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

host="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')" || true
if [ -z "${host:-}" ]; then
    echo "scripts/xtask.sh: could not determine the host triple from 'rustc -vV'." >&2
    echo "  Run this inside the dev shell: ./scripts/dev-shell.sh scripts/xtask.sh $*" >&2
    exit 1
fi

exec cargo run -p xtask --target "$host" --quiet -- "$@"
