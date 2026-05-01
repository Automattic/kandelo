#!/usr/bin/env bash
#
# Stage per-PR archives + binaries.lock.pr overlay into a directory
# ready for upload to a `pr-<NNN>-staging` GitHub pre-release. Helper
# invoked by publish-pr-staging.sh.
#
# Usage:
#   scripts/stage-pr-staging.sh --pr <N> --out <staging-dir> \
#       [--baseline-tag <tag>] [--arch wasm32|wasm64]... \
#       [--force-rebuild <name>]... [--force-rebuild-all]
#
# Reads `binaries.lock` to find the durable release tag (or use
# --baseline-tag to override), downloads its manifest.json, then
# invokes `xtask stage-pr-overlay` against it.
#
# --force-rebuild / --force-rebuild-all source-build the named
# manifests and treat them as changed-vs-baseline even when their
# cache_key_sha matches the baseline. Useful for local dry runs to
# confirm a fresh archive against a suspected stale durable entry.
#
# Output:
#   $STAGING/libs/*.tar.zst         (only changed libraries)
#   $STAGING/programs/*.tar.zst     (only changed programs)
#   $STAGING/manifest.json          (entries for changed archives only)
#   $STAGING/binaries.lock.pr       (the overlay file)
#
# Default --arch: wasm32 only. Pass --arch repeatedly to broaden.
#
# Exit codes:
#   0  staged successfully (overlay's `overrides` may be empty if no
#      cache_key_sha changed — caller should branch on that)
#   1  setup error (missing baseline manifest, network failure)
#   2  bad arguments / missing prerequisite tool

set -euo pipefail

PR=""
STAGING=""
BASELINE_TAG=""
ARCHES=()
FORCE_REBUILD_NAMES=()
FORCE_REBUILD_ALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --pr)                  PR="$2"; shift 2 ;;
        --out)                 STAGING="$2"; shift 2 ;;
        --baseline-tag)        BASELINE_TAG="$2"; shift 2 ;;
        --arch)                ARCHES+=("$2"); shift 2 ;;
        --force-rebuild)       FORCE_REBUILD_NAMES+=("$2"); shift 2 ;;
        --force-rebuild-all)   FORCE_REBUILD_ALL=1; shift ;;
        -h|--help)
            sed -n '3,32p' "$0"
            exit 0
            ;;
        *) echo "unknown arg $1" >&2; exit 2 ;;
    esac
done

[ -n "$PR" ]      || { echo "--pr <N> is required" >&2; exit 2; }
[ -n "$STAGING" ] || { echo "--out <staging-dir> is required" >&2; exit 2; }
case "$PR" in
    ''|*[!0-9]*) echo "--pr must be a positive integer (got: $PR)" >&2; exit 2 ;;
esac

for tool in curl jq cargo rustc; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: $tool not found on PATH" >&2
        exit 2
    }
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ -z "$BASELINE_TAG" ]; then
    [ -f "$REPO_ROOT/binaries.lock" ] || {
        echo "ERROR: $REPO_ROOT/binaries.lock not found and no --baseline-tag given" >&2
        exit 1
    }
    BASELINE_TAG=$(jq -r .release_tag "$REPO_ROOT/binaries.lock")
    [ "$BASELINE_TAG" = "null" ] && {
        echo "ERROR: binaries.lock missing release_tag" >&2
        exit 1
    }
fi

if [ ${#ARCHES[@]} -eq 0 ]; then
    ARCHES=(wasm32)
fi

# Download baseline manifest into a temp file. fetch-binaries.sh
# normally caches it under binaries/objects/<sha>.json but we're
# stage-side so we just need it transiently.
BASELINE_TMP=$(mktemp -t baseline-manifest.XXXXXX).json
trap 'rm -f "$BASELINE_TMP"' EXIT

BASELINE_URL="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/$BASELINE_TAG/manifest.json"
echo "stage-pr-staging: fetching baseline manifest from $BASELINE_TAG"
if ! curl -fsSL --retry 3 -o "$BASELINE_TMP" "$BASELINE_URL"; then
    echo "ERROR: failed to download baseline manifest from $BASELINE_URL" >&2
    exit 1
fi

rm -rf "$STAGING" && mkdir -p "$STAGING"

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
arch_args=()
for a in "${ARCHES[@]}"; do
    arch_args+=(--arch "$a")
done

force_args=()
if [ "$FORCE_REBUILD_ALL" = "1" ]; then
    force_args+=(--force-rebuild-all)
fi
if [ ${#FORCE_REBUILD_NAMES[@]} -gt 0 ]; then
    for n in "${FORCE_REBUILD_NAMES[@]}"; do
        force_args+=(--force-rebuild "$n")
    done
fi

echo "== Staging PR overlay for PR #$PR (arches: ${ARCHES[*]}) =="
# --continue-on-error: a single package whose source build fails on
# the runner (e.g. mariadb-test wants the full mysql-test directory
# from a host MariaDB build) should not abort the whole overlay.
# Such packages stay at their durable-release version; only packages
# that successfully (re)stage become overrides.
cargo run -p xtask --target "$HOST_TARGET" --quiet -- stage-pr-overlay \
    --baseline-manifest "$BASELINE_TMP" \
    --staging-tag "pr-${PR}-staging" \
    --out "$STAGING" \
    --continue-on-error \
    "${arch_args[@]}" \
    ${force_args[@]+"${force_args[@]}"}

if [ ! -f "$STAGING/binaries.lock.pr" ]; then
    echo "ERROR: xtask did not produce $STAGING/binaries.lock.pr" >&2
    exit 1
fi

OVERRIDE_COUNT=$(jq '.overrides | length' "$STAGING/binaries.lock.pr")
echo
echo "== stage-pr-staging: $OVERRIDE_COUNT override(s) staged =="
if [ "$OVERRIDE_COUNT" -gt 0 ]; then
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        # `wc -c < <file>` is portable across BSD and GNU coreutils;
        # `stat -f %z` (BSD) and `stat -c %s` (GNU) collide on syntax
        # under Nix's GNU stat, which interprets `-f` as filesystem-info.
        sz=$(wc -c < "$f" | tr -d ' ')
        printf "  %10s  %s\n" "$sz" "$(basename "$f")"
    done < <({
        find "$STAGING/libs" -maxdepth 1 -type f 2>/dev/null
        find "$STAGING/programs" -maxdepth 1 -type f 2>/dev/null
    } | sort)
fi
echo
echo "Ready for: scripts/publish-pr-staging.sh --pr $PR --staging $STAGING"
