#!/usr/bin/env bash
#
# Stage every release asset into a flat directory and generate
# manifest.json. Helper invoked by publish-release.sh.
#
# Usage:
#   scripts/stage-release.sh --out /tmp/release-staging
#
# In V2, two staging halves:
#   1. V1 entries (kernel/userspace/test programs) — no deps.toml,
#      bundled the legacy way via `xtask bundle-program --plain-wasm`.
#   2. V2 entries (libs + programs with deps.toml) — staged via
#      `xtask stage-release`, which produces .tar.zst archives in
#      $STAGING/{libs,programs}/ and writes manifest.json that includes
#      both halves' entries.
#
# Requires built binaries in their canonical locations:
#   target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm
#   target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm
#   host/wasm/{exec-caller,exec-child,fork-exec,ifhwaddr,mmap_shared_test,hello64}.wasm
#
# Plus the cache must be populated for every (kind=library|program, arch)
# pair the V2 staging covers — `xtask stage-release` runs ensure_built
# itself, so a clean cache is fine; an out-of-date cache is also fine.

set -euo pipefail

STAGING=""
ABI=""
while [ $# -gt 0 ]; do
    case "$1" in
        --out) STAGING="$2"; shift 2 ;;
        --abi) ABI="$2"; shift 2 ;;
        *) echo "unknown arg $1" >&2; exit 2 ;;
    esac
done
[ -n "$STAGING" ] || { echo "--out is required" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
if [ -z "$ABI" ]; then
    ABI=$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')
fi
TAG="binaries-abi-v$ABI"

rm -rf "$STAGING" && mkdir -p "$STAGING"

run_xtask() {
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- "$@"
}

# ===========================================================================
# Half 1 — V1 entries: kernel, userspace, test programs.
# These have no deps.toml registry and are bundled the legacy way.
# ===========================================================================
stage_v1_entries() {
    # Kernel + userspace: plain wasm.
    run_xtask bundle-program --plain-wasm \
        --program kernel \
        --binary target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm \
        --out-dir "$STAGING"
    run_xtask bundle-program --plain-wasm \
        --program userspace \
        --binary target/wasm64-unknown-unknown/release/wasm_posix_userspace.wasm \
        --out-dir "$STAGING"

    # Test/example programs.
    stage_example() {
        local name="$1"; local src="$2"
        run_xtask bundle-program \
            --plain-wasm \
            --program "$name" \
            --upstream-version 0.1.0 \
            --revision 1 \
            --binary "$src" \
            --out-dir "$STAGING"
    }
    stage_example exec-caller       local-binaries/programs/exec-caller.wasm
    stage_example exec-child        local-binaries/programs/exec-child.wasm
    stage_example fork-exec         local-binaries/programs/fork-exec.wasm
    stage_example ifhwaddr          local-binaries/programs/ifhwaddr.wasm
    stage_example mmap_shared_test  local-binaries/programs/mmap_shared_test.wasm
    stage_example hello64           local-binaries/programs/hello64.wasm
}

# ===========================================================================
# Half 2 — V2 entries: every kind=library or kind=program manifest.
# stage-release walks Registry::walk_all(), filters by kind, fans out
# across {wasm32, wasm64}, calls ensure_built + archive_stage, then
# generates manifest.json that includes BOTH halves' entries.
# ===========================================================================
stage_v2_entries() {
    local timestamp
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local host
    host="$(uname -sm | tr ' ' '-' | tr 'A-Z' 'a-z')"
    run_xtask stage-release \
        --staging "$STAGING" \
        --abi "$ABI" \
        --tag "$TAG" \
        --arch wasm32 \
        --arch wasm64 \
        --build-timestamp "$timestamp" \
        --build-host "$host" \
        --continue-on-error
}

# ---------------------------------------------------------------------------

echo "== Staging V1 entries (kernel, userspace, test programs) =="
stage_v1_entries
echo

echo "== Staging V2 entries (libs + programs across wasm32 + wasm64) =="
stage_v2_entries
echo

echo "== Staged assets =="
{
    find "$STAGING" -maxdepth 1 -type f
    find "$STAGING/libs" -maxdepth 1 -type f 2>/dev/null
    find "$STAGING/programs" -maxdepth 1 -type f 2>/dev/null
} | sort | xargs -I{} sh -c 'sz=$(stat -f %z "{}" 2>/dev/null || stat -c %s "{}"); printf "  %10s  %s\n" "$sz" "$(basename "{}")"'
