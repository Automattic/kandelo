#!/usr/bin/env bash
#
# Publish a binaries release to GitHub. See docs/binary-releases.md.
#
# Usage:
#   scripts/publish-release.sh --tag binaries-abi-v<N>-YYYY-MM-DD \
#       --staging /path/to/staging-dir
#
# Prerequisites:
#   - `gh` and `jq` CLIs on PATH; `gh` authenticated against the
#     upstream repo.
#   - Staging directory already populated by `scripts/stage-release.sh`,
#     including manifest.json and the {libs,programs}/ subdirectories
#     produced by V2 archive staging.
#   - The tag must begin with `binaries-abi-v<ABI_VERSION>` — the
#     manifest produced by stage-release encodes the full tag (including
#     any `-YYYY-MM-DD` snapshot suffix). This script asserts they match
#     before uploading; drift would otherwise surface at consumer-side
#     validation in `scripts/fetch-binaries.sh`.
#
# The script is deliberately thin: it exists so the PR review sees the
# exact commands that run, and so the publishing flow is scriptable for
# when it gets moved to GitHub Actions.

set -euo pipefail

TAG=""
STAGING=""

while [ $# -gt 0 ]; do
    case "$1" in
        --tag)          TAG="$2"; shift 2 ;;
        --staging)      STAGING="$2"; shift 2 ;;
        -h|--help)
            sed -n '3,20p' "$0"
            exit 0
            ;;
        *)
            echo "unknown arg $1" >&2
            exit 2
            ;;
    esac
done

if [ -z "$TAG" ]; then
    echo "--tag is required (e.g. binaries-abi-v2-2026-04-19)" >&2
    exit 2
fi
if [ -z "$STAGING" ]; then
    echo "--staging <dir> is required (run scripts/stage-release.sh first)" >&2
    exit 2
fi
if [ ! -d "$STAGING" ]; then
    echo "staging dir $STAGING does not exist" >&2
    exit 1
fi
if [ ! -f "$STAGING/manifest.json" ]; then
    echo "staging dir $STAGING is missing manifest.json — run scripts/stage-release.sh first" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The staged manifest's release_tag is what fetch-binaries.sh
# compares against binaries.lock on the consumer side. If we upload
# a manifest whose release_tag disagrees with the GitHub tag we're
# creating, every downstream `fetch-binaries.sh` run fails. Catch
# the drift here, before `gh release create`, rather than after.
manifest_tag=$(jq -r .release_tag "$STAGING/manifest.json" 2>/dev/null || echo "<unparseable>")
if [ "$manifest_tag" != "$TAG" ]; then
    echo "ERROR: staged manifest.json release_tag=$manifest_tag does not match --tag=$TAG" >&2
    echo "  Re-run scripts/stage-release.sh with --tag $TAG (the manifest's" >&2
    echo "  release_tag field is what fetch-binaries.sh validates against" >&2
    echo "  binaries.lock — see docs/binary-releases.md)." >&2
    exit 1
fi

echo "== Manifest =="
cat "$STAGING/manifest.json"
echo

# Build the asset list: every regular file under staging, including
# the V2 {libs,programs}/ subdirectories produced by xtask stage-release.
assets=()
while IFS= read -r -d '' f; do
    assets+=("$f")
done < <(
    {
        find "$STAGING" -maxdepth 1 -type f -print0
        find "$STAGING/libs" -maxdepth 1 -type f -print0 2>/dev/null
        find "$STAGING/programs" -maxdepth 1 -type f -print0 2>/dev/null
    } | sort -z
)

echo "== Would upload ${#assets[@]} assets to release $TAG =="
for a in "${assets[@]}"; do
    size=$(stat -f %z "$a" 2>/dev/null || stat -c %s "$a")
    printf "  %10s  %s\n" "$size" "$(basename "$a")"
done

if [ "${DRY_RUN:-0}" = "1" ]; then
    echo
    echo "DRY_RUN=1 — stopping before gh release create."
    exit 0
fi

echo
echo "Creating release $TAG on GitHub..."
gh release create "$TAG" \
    --title "Binaries for ABI v${TAG#binaries-abi-v}" \
    --notes "Prebuilt Wasm binaries for \`wasm_posix_shared::ABI_VERSION\`. See docs/binary-releases.md for the manifest.json schema and consumption flow." \
    "${assets[@]}"

echo
echo "Released: https://github.com/brandonpayton/wasm-posix-kernel/releases/tag/$TAG"

# Post-upload verification: walk the just-published release and confirm
# every archive's bytes hash to its manifest entry's archive_sha256.
# Catches the kind of drift that bit binaries-abi-v6-2026-04-29 (manifest
# re-uploaded with new shas while archive bytes stayed old, surfaced as
# `./run.sh browser` failures days later).
echo
echo "Verifying release consistency (local manifest + staging dir)..."
# Verify against the local staging bytes (just uploaded) instead of
# --tag — the release CDN serves cached assets for several minutes
# after upload and would false-positive a freshly-published tag.
"$REPO_ROOT/scripts/verify-release.sh" \
    --manifest "$STAGING/manifest.json" \
    --archive-base "$STAGING"

echo
echo "Commit abi/manifest.json into the repo as the reference copy if"
echo "you haven't already:"
echo "  cp $STAGING/manifest.json abi/manifest.json"
