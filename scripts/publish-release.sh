#!/usr/bin/env bash
#
# Publish a binaries release to GitHub. See docs/binary-releases.md.
#
# Usage:
#   scripts/publish-release.sh --tag binaries-abi-v<N>-YYYY-MM-DD \
#       --staging /path/to/staging-dir
#
# Prerequisites:
#   - `gh` CLI authenticated against the upstream repo.
#   - Staging directory already populated by `scripts/stage-release.sh`,
#     including manifest.json and the {libs,programs}/ subdirectories
#     produced by V2 archive staging.
#   - The tag must begin with `binaries-abi-v<ABI_VERSION>` — the
#     manifest produced by stage-release encodes the same prefix, so
#     drift here would surface at consumer-side validation.
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
echo
echo "Commit abi/manifest.json into the repo as the reference copy if"
echo "you haven't already:"
echo "  cp $STAGING/manifest.json abi/manifest.json"
