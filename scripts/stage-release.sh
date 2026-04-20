#!/usr/bin/env bash
#
# Stage every release asset into a flat directory and generate
# manifest.json. Helper invoked by publish-release.sh.
#
# Usage:
#   scripts/stage-release.sh --out /tmp/release-staging
#
# Requires built binaries in their canonical locations:
#   target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm
#   target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm
#   host/wasm/{exec-caller,exec-child,fork-exec,ifhwaddr,mmap_shared_test,hello64,sh}.wasm
#   examples/libs/dash/bin/dash.wasm
#   examples/libs/git/bin/{git.wasm,git-remote-http.wasm}
#   examples/libs/vim/bin/vim.wasm (+ runtime at examples/libs/vim/runtime/)

set -euo pipefail

STAGING=""
while [ $# -gt 0 ]; do
    case "$1" in
        --out) STAGING="$2"; shift 2 ;;
        *) echo "unknown arg $1" >&2; exit 2 ;;
    esac
done
[ -n "$STAGING" ] || { echo "--out is required" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
rm -rf "$STAGING" && mkdir -p "$STAGING"

run_xtask() {
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- "$@"
}

# ---------------------------------------------------------------------------
# Kernel + userspace: plain wasm, no bundling.
# ---------------------------------------------------------------------------
run_xtask bundle-program --plain-wasm \
    --program kernel \
    --binary target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm \
    --out-dir "$STAGING"

run_xtask bundle-program --plain-wasm \
    --program userspace \
    --binary target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm \
    --out-dir "$STAGING"

# ---------------------------------------------------------------------------
# Test/example programs — bundle each into its own zip. Version 0.1.0
# placeholder since these don't track an upstream.
# ---------------------------------------------------------------------------
stage_example() {
    local name="$1"; local src="$2"
    run_xtask bundle-program \
        --program "$name" \
        --upstream-version 0.1.0 \
        --revision 1 \
        --binary "$src" \
        --out-dir "$STAGING"
}

stage_example exec-caller       host/wasm/exec-caller.wasm
stage_example exec-child        host/wasm/exec-child.wasm
stage_example fork-exec         host/wasm/fork-exec.wasm
stage_example ifhwaddr          host/wasm/ifhwaddr.wasm
stage_example mmap_shared_test  host/wasm/mmap_shared_test.wasm
stage_example hello64           host/wasm/hello64.wasm

# ---------------------------------------------------------------------------
# Ported programs with real upstream versions.
# ---------------------------------------------------------------------------
# dash: the canonical source of truth for the shell. host/wasm/sh.wasm is
# a byte-identical copy currently; we ship it under the `sh` program so
# consumers using sh.wasm keep working, but it aliases to dash in
# program-metadata.toml.
run_xtask bundle-program \
    --program dash \
    --upstream-version 0.5.12 \
    --revision 1 \
    --binary examples/libs/dash/bin/dash.wasm \
    --out-dir "$STAGING"

# sh is a copy of dash wrapped under the sh program name (separate zip).
run_xtask bundle-program \
    --program sh \
    --upstream-version 0.5.12 \
    --revision 1 \
    --binary host/wasm/sh.wasm \
    --out-dir "$STAGING"

# git: the git binary + its git-remote-http transport helper in one
# bundle, since they're inseparable at runtime.
run_xtask bundle-program \
    --program git \
    --upstream-version 2.47.1 \
    --revision 1 \
    --binary examples/libs/git/bin/git.wasm \
    --extra-file "examples/libs/git/bin/git-remote-http.wasm=git-remote-http.wasm" \
    --out-dir "$STAGING"

# vim: the binary plus its runtime (syntax/ftplugin/colors/autoload/etc.)
VIM_LICENSE="examples/libs/vim/vim-src/LICENSE"
vim_license_arg=()
if [ -f "$VIM_LICENSE" ]; then
    vim_license_arg=(--license "$VIM_LICENSE")
fi
run_xtask bundle-program \
    --program vim \
    --upstream-version 9.1.0900 \
    --revision 1 \
    --binary examples/libs/vim/bin/vim.wasm \
    --runtime-root examples/libs/vim/runtime \
    --runtime-prefix share/vim/vim91 \
    "${vim_license_arg[@]}" \
    --out-dir "$STAGING"

# ---------------------------------------------------------------------------
# Generate manifest.
# ---------------------------------------------------------------------------
run_xtask build-manifest \
    --in "$STAGING" \
    --out "$STAGING/manifest.json" \
    --tag "binaries-abi-v$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')" \
    ${GENERATED_AT:+--generated-at "$GENERATED_AT"}

echo
echo "== Staged assets =="
ls -la "$STAGING/" | grep -v '^total' | grep -v '^d' | awk '{printf "  %10s  %s\n", $5, $NF}'
