#!/usr/bin/env bash
#
# Stage every release asset into a flat directory and generate
# manifest.json. Helper invoked by publish-release.sh.
#
# Usage:
#   scripts/stage-release.sh --out /tmp/release-staging \
#       [--abi <N>] [--arch wasm32|wasm64]...
#
# Default --abi: ABI_VERSION from crates/shared/src/lib.rs.
# Default --arch: wasm32 only.  Pass --arch repeatedly to broaden.
#
# Output: $STAGING/{libs,programs}/<archive>.tar.zst plus manifest.json.
#
# `xtask stage-release` walks examples/libs/<name>/deps.toml entries
# (kind = "library" or "program") and runs the resolver's ensure_built
# + archive_stage on each.  Composite metadata manifests without a
# build script (kernel, userspace, examples, shell, lamp, node,
# wordpress) fail their per-arch ensure_built and become WARN-only
# under --continue-on-error.  The first cut therefore contains only
# the libs and the ported programs that have working build scripts.
#
# kernel.wasm and userspace.wasm are not in the release; they're built
# locally by `bash build.sh` and live in local-binaries/.  This is a
# deliberate v0 limitation — distribution-only consumers (no Rust
# toolchain) will need a follow-up that bundles them.

set -euo pipefail

STAGING=""
ABI=""
ARCHES=()
KINDS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --out) STAGING="$2"; shift 2 ;;
        --abi) ABI="$2"; shift 2 ;;
        --arch) ARCHES+=("$2"); shift 2 ;;
        --kind) KINDS+=("$2"); shift 2 ;;
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

if [ ${#ARCHES[@]} -eq 0 ]; then
    ARCHES=(wasm32)
fi

rm -rf "$STAGING" && mkdir -p "$STAGING"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
host="$(uname -sm | tr ' ' '-' | tr 'A-Z' 'a-z')"

arch_args=()
for a in "${ARCHES[@]}"; do
    arch_args+=(--arch "$a")
done

kind_args=()
if [ ${#KINDS[@]} -gt 0 ]; then
    for k in "${KINDS[@]}"; do
        kind_args+=(--kind "$k")
    done
fi

echo "== Staging archive entries (kinds: ${KINDS[*]:-library,program}, arches: ${ARCHES[*]}) =="
cargo run -p xtask --target "$HOST_TARGET" --quiet -- stage-release \
    --staging "$STAGING" \
    --abi "$ABI" \
    --tag "$TAG" \
    "${arch_args[@]}" \
    ${kind_args[@]+"${kind_args[@]}"} \
    --build-timestamp "$timestamp" \
    --build-host "$host" \
    --continue-on-error
echo

echo "== Staged assets =="
{
    find "$STAGING" -maxdepth 1 -type f
    find "$STAGING/libs" -maxdepth 1 -type f 2>/dev/null
    find "$STAGING/programs" -maxdepth 1 -type f 2>/dev/null
} | sort | xargs -I{} sh -c 'sz=$(stat -f %z "{}" 2>/dev/null || stat -c %s "{}"); printf "  %10s  %s\n" "$sz" "$(basename "{}")"'
