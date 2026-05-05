#!/usr/bin/env bash
#
# Stage every release asset into a flat directory and generate
# manifest.json. Helper invoked by publish-release.sh.
#
# Usage:
#   scripts/stage-release.sh --out /tmp/release-staging \
#       --tag binaries-abi-v<N>-YYYY-MM-DD \
#       [--abi <N>] [--arch wasm32|wasm64]... \
#       [--force-rebuild <name>]... [--force-rebuild-all]
#
# --force-rebuild / --force-rebuild-all source-build the named
# manifests instead of using the content-addressed cache or fetching
# `[binary].archive_url`. Used by the manual force-rebuild workflow
# to refresh archives whose cache key is suspected stale.
#
# --tag is required and must match the GitHub Release tag the
# manifest will be published under (see docs/binary-releases.md).
# It is baked into the manifest.json `release_tag` field, so a
# mismatch with publish-release.sh's --tag would be caught by
# fetch-binaries.sh on the consumer side.
#
# Default --abi: ABI_VERSION from crates/shared/src/lib.rs.
# Default --arch: wasm32 only.  Pass --arch repeatedly to broaden.
#
# Output: $STAGING/{libs,programs}/<archive>.tar.zst plus manifest.json.
#
# `xtask stage-release` walks examples/libs/<name>/package.toml entries
# (kind = "library" or "program") and runs the resolver's ensure_built
# + archive_stage on each. Strict-by-default: if any manifest fails to
# build for *every* requested arch, the staging step aborts before
# `manifest.json` is written, so publish-release.sh + prepare-merge.yml
# never publish a release with packages silently dropped. Partial-arch
# failures (e.g. wasm32 succeeds, wasm64 doesn't) are still downgraded
# to warnings — see xtask/src/stage_release.rs:216-234.
#
# kernel.wasm and userspace.wasm are not in the release; they're built
# locally by `bash build.sh` and live in local-binaries/.  This is a
# deliberate v0 limitation — distribution-only consumers (no Rust
# toolchain) will need a follow-up that bundles them.

set -euo pipefail

STAGING=""
ABI=""
TAG=""
ARCHES=()
KINDS=()
FORCE_REBUILD_NAMES=()
FORCE_REBUILD_ALL=0
ALLOW_FAILURE_NAMES=()
while [ $# -gt 0 ]; do
    case "$1" in
        --out) STAGING="$2"; shift 2 ;;
        --abi) ABI="$2"; shift 2 ;;
        --tag) TAG="$2"; shift 2 ;;
        --arch) ARCHES+=("$2"); shift 2 ;;
        --kind) KINDS+=("$2"); shift 2 ;;
        --force-rebuild) FORCE_REBUILD_NAMES+=("$2"); shift 2 ;;
        --force-rebuild-all) FORCE_REBUILD_ALL=1; shift ;;
        --allow-failure) ALLOW_FAILURE_NAMES+=("$2"); shift 2 ;;
        *) echo "unknown arg $1" >&2; exit 2 ;;
    esac
done
[ -n "$STAGING" ] || { echo "--out is required" >&2; exit 2; }
[ -n "$TAG" ] || {
    echo "--tag is required (e.g. binaries-abi-v6-2026-04-29)." >&2
    echo "  The tag is baked into manifest.json's release_tag field," >&2
    echo "  and must match the GitHub release tag publish-release.sh uploads to." >&2
    exit 2
}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
if [ -z "$ABI" ]; then
    ABI=$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')
fi

# Sanity-check that the tag begins with binaries-abi-v$ABI. xtask
# stage-release will reject a fully bogus tag, but giving an early
# error here is easier to debug than a Rust panic mid-stage.
case "$TAG" in
    binaries-abi-v"$ABI"|binaries-abi-v"$ABI"-*) ;;
    *)
        echo "ERROR: --tag $TAG does not start with binaries-abi-v$ABI" >&2
        echo "  (--abi=$ABI; tag must be binaries-abi-v$ABI or binaries-abi-v$ABI-YYYY-MM-DD)" >&2
        exit 2
        ;;
esac

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

force_args=()
if [ "$FORCE_REBUILD_ALL" = "1" ]; then
    force_args+=(--force-rebuild-all)
fi
if [ ${#FORCE_REBUILD_NAMES[@]} -gt 0 ]; then
    for n in "${FORCE_REBUILD_NAMES[@]}"; do
        force_args+=(--force-rebuild "$n")
    done
fi

allow_args=()
if [ ${#ALLOW_FAILURE_NAMES[@]} -gt 0 ]; then
    for n in "${ALLOW_FAILURE_NAMES[@]}"; do
        allow_args+=(--allow-failure "$n")
    done
fi

echo "== Staging archive entries (kinds: ${KINDS[*]:-library,program}, arches: ${ARCHES[*]}) =="
cargo run -p xtask --target "$HOST_TARGET" --quiet -- stage-release \
    --staging "$STAGING" \
    --abi "$ABI" \
    --tag "$TAG" \
    "${arch_args[@]}" \
    ${kind_args[@]+"${kind_args[@]}"} \
    ${force_args[@]+"${force_args[@]}"} \
    ${allow_args[@]+"${allow_args[@]}"} \
    --build-timestamp "$timestamp" \
    --build-host "$host"
echo

echo "== Staged assets =="
{
    find "$STAGING" -maxdepth 1 -type f
    find "$STAGING/libs" -maxdepth 1 -type f 2>/dev/null
    find "$STAGING/programs" -maxdepth 1 -type f 2>/dev/null
} | sort | xargs -I{} sh -c 'sz=$(stat -f %z "{}" 2>/dev/null || stat -c %s "{}"); printf "  %10s  %s\n" "$sz" "$(basename "{}")"'
