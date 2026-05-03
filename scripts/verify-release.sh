#!/usr/bin/env bash
#
# Verify that every archive listed in a release's manifest.json hashes
# to the manifest's claimed `archive_sha256`. Catches drift between
# manifest entries and the actual asset bytes (the kind that bit
# binaries-abi-v6-2026-04-29 — manifest re-uploaded with new shas while
# archive bytes stayed old, surfaced as a `./run.sh browser` failure).
#
# Usage:
#   scripts/verify-release.sh --tag <release-tag> [--owner-repo <owner/repo>]
#   scripts/verify-release.sh --manifest <local-manifest.json> --archive-base <url-or-dir>
#
# The first form fetches manifest.json from the GitHub release at
# `<release-tag>` and verifies every asset against it. The second form
# is for local staging directories before publish (used by
# publish-release.sh / publish-pr-staging.sh as a post-upload check).
#
# Exit codes:
#   0  every archive's bytes hash to its manifest entry's archive_sha256
#   1  one or more drift / fetch errors
#   2  bad arguments / missing prerequisite tool

set -euo pipefail

TAG=""
OWNER_REPO="brandonpayton/wasm-posix-kernel"
MANIFEST=""
ARCHIVE_BASE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --tag)          TAG="$2"; shift 2 ;;
        --owner-repo)   OWNER_REPO="$2"; shift 2 ;;
        --manifest)     MANIFEST="$2"; shift 2 ;;
        --archive-base) ARCHIVE_BASE="$2"; shift 2 ;;
        -h|--help)      sed -n '3,22p' "$0"; exit 0 ;;
        *)              echo "unknown arg $1" >&2; exit 2 ;;
    esac
done

for tool in curl shasum jq; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: $tool not found on PATH" >&2
        exit 2
    }
done

# Resolve manifest source.
if [ -n "$TAG" ]; then
    if [ -n "$MANIFEST" ] || [ -n "$ARCHIVE_BASE" ]; then
        echo "ERROR: --tag is exclusive with --manifest / --archive-base" >&2
        exit 2
    fi
    ARCHIVE_BASE="https://github.com/$OWNER_REPO/releases/download/$TAG"
    MANIFEST_TMP=$(mktemp -t verify-release.XXXXXX).json
    trap 'rm -f "$MANIFEST_TMP"' EXIT
    echo "verify-release: fetching manifest from $TAG"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL --retry 3 -o "$MANIFEST_TMP" "$ARCHIVE_BASE/manifest.json" || {
        echo "ERROR: failed to download manifest.json from $ARCHIVE_BASE" >&2
        exit 1
    }
    MANIFEST="$MANIFEST_TMP"
elif [ -n "$MANIFEST" ]; then
    [ -f "$MANIFEST" ] || { echo "ERROR: $MANIFEST not found" >&2; exit 2; }
    [ -n "$ARCHIVE_BASE" ] || { echo "ERROR: --manifest requires --archive-base" >&2; exit 2; }
else
    echo "ERROR: must pass either --tag <tag> or --manifest <path> --archive-base <url-or-dir>" >&2
    exit 2
fi

manifest_tag=$(jq -r .release_tag "$MANIFEST")
echo "verify-release: archive-base=$ARCHIVE_BASE manifest release_tag=$manifest_tag"

OK=0
FAIL=0
MISSING=0
TOTAL=$(jq '[.entries[] | select(.archive_name)] | length' "$MANIFEST")
[ "$TOTAL" -gt 0 ] || { echo "verify-release: no archive entries (legacy-only manifest); nothing to verify"; exit 0; }

# Stream entries; one per line: <archive_name> <archive_sha256>.
while read -r archive_name archive_sha; do
    if [ "$ARCHIVE_BASE" != "${ARCHIVE_BASE#http}" ]; then
        # URL fetch.
        url="$ARCHIVE_BASE/$archive_name"
        actual=$(curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL --retry 3 "$url" 2>/dev/null | shasum -a 256 | awk '{print $1}')
        if [ -z "$actual" ] || [ ${#actual} -ne 64 ]; then
            printf "  MISSING %s (download failed from %s)\n" "$archive_name" "$url"
            MISSING=$((MISSING + 1))
            continue
        fi
    else
        # Local dir.
        f="$ARCHIVE_BASE/$archive_name"
        # Try {libs,programs} subdirs as a fallback (matches stage-release layout).
        for candidate in "$f" "$ARCHIVE_BASE/libs/$archive_name" "$ARCHIVE_BASE/programs/$archive_name"; do
            [ -f "$candidate" ] && { f="$candidate"; break; }
        done
        if [ ! -f "$f" ]; then
            printf "  MISSING %s (no file under %s)\n" "$archive_name" "$ARCHIVE_BASE"
            MISSING=$((MISSING + 1))
            continue
        fi
        actual=$(shasum -a 256 "$f" | awk '{print $1}')
    fi
    if [ "$actual" = "$archive_sha" ]; then
        OK=$((OK + 1))
    else
        printf "  MISMATCH %s\n    expected: %s\n    got:      %s\n" "$archive_name" "$archive_sha" "$actual"
        FAIL=$((FAIL + 1))
    fi
done < <(jq -r '.entries[] | select(.archive_name) | "\(.archive_name) \(.archive_sha256)"' "$MANIFEST")

echo
echo "verify-release: $OK ok / $FAIL mismatch / $MISSING missing (of $TOTAL archive entries)"
if [ "$FAIL" -gt 0 ] || [ "$MISSING" -gt 0 ]; then
    exit 1
fi
exit 0
