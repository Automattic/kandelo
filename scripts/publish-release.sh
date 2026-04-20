#!/usr/bin/env bash
#
# Publish a binaries release to GitHub. See docs/binary-releases.md.
#
# Usage:
#   scripts/publish-release.sh --tag binaries-abi-v<N>-YYYY-MM-DD \
#       [--staging /path/to/staging-dir] [--generated-at <ISO8601>]
#
# Prerequisites:
#   - `gh` CLI authenticated against the upstream repo.
#   - Staging directory populated with every asset you want in the
#     release (flat layout, no subdirectories). The script generates
#     manifest.json inside the staging dir via `cargo xtask build-manifest`.
#   - The tag must begin with `binaries-abi-v<ABI_VERSION>` — the xtask
#     refuses mismatches, which this script then inherits.
#
# The script is deliberately thin: it exists so the PR review sees the
# exact commands that run, and so the publishing flow is scriptable for
# when it gets moved to GitHub Actions.

set -euo pipefail

TAG=""
STAGING=""
GENERATED_AT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --tag)          TAG="$2"; shift 2 ;;
        --staging)      STAGING="$2"; shift 2 ;;
        --generated-at) GENERATED_AT="$2"; shift 2 ;;
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
    echo "--staging <dir> is required (every asset must already be present)" >&2
    exit 2
fi
if [ ! -d "$STAGING" ]; then
    echo "staging dir $STAGING does not exist" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"

echo "== Generating manifest for $TAG =="
build_manifest_args=(
    build-manifest
    --in "$STAGING"
    --out "$STAGING/manifest.json"
    --tag "$TAG"
)
if [ -n "$GENERATED_AT" ]; then
    build_manifest_args+=(--generated-at "$GENERATED_AT")
fi
cargo run -p xtask --target "$HOST_TARGET" --quiet -- "${build_manifest_args[@]}"

echo
echo "== Manifest =="
cat "$STAGING/manifest.json"
echo

# Build the asset list: every regular file under staging.
assets=()
while IFS= read -r -d '' f; do
    assets+=("$f")
done < <(find "$STAGING" -maxdepth 1 -type f -print0 | sort -z)

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
